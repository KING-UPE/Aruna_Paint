-- Sync outbox: every change writes a row to sync_outbox inside the same database transaction,
-- so nothing can be missed. The sync agent pushes these rows to the cloud mirror, which applies
-- each change only once (keyed by sync_outbox.id), so retries never double anything.

CREATE OR REPLACE FUNCTION sync_capture() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  row_data jsonb;
  pk jsonb := '{}'::jsonb;
  col text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_data := to_jsonb(OLD);
  ELSE
    row_data := to_jsonb(NEW);
  END IF;
  IF TG_OP = 'UPDATE' AND to_jsonb(OLD) = row_data THEN
    RETURN NULL;
  END IF;
  FOREACH col IN ARRAY string_to_array(TG_ARGV[0], ',') LOOP
    pk := pk || jsonb_build_object(col, row_data -> col);
  END LOOP;
  -- Columns that never leave the shop (TG_ARGV[1], comma-separated).
  IF TG_ARGV[1] <> '' THEN
    row_data := row_data - string_to_array(TG_ARGV[1], ',');
  END IF;
  INSERT INTO sync_outbox (table_name, op, pk, data)
  VALUES (TG_TABLE_NAME, TG_OP, pk, CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE row_data END);
  RETURN NULL;
END
$$;

-- Attaches the capture trigger to every table except the ones that stay at the shop.
-- Call it again at the end of any migration that adds a table.
CREATE OR REPLACE FUNCTION sync_attach_all() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  t record;
  pkcols text;
  excluded text;
BEGIN
  FOR t IN
    SELECT c.oid, c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relkind = 'r'
      AND c.relname NOT IN ('sync_outbox', 'sync_state', 'sessions', 'recovery_codes', '_prisma_migrations')
  LOOP
    SELECT string_agg(a.attname, ',' ORDER BY array_position(i.indkey::int2[], a.attnum))
      INTO pkcols
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
     WHERE i.indrelid = t.oid AND i.indisprimary;
    IF pkcols IS NULL THEN
      RAISE EXCEPTION 'Table % has no primary key and cannot sync', t.name;
    END IF;
    excluded := CASE t.name WHEN 'users' THEN 'pin_hmac' ELSE '' END;
    EXECUTE format('DROP TRIGGER IF EXISTS zz_sync_capture ON %I', t.name);
    EXECUTE format(
      'CREATE TRIGGER zz_sync_capture AFTER INSERT OR UPDATE OR DELETE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION sync_capture(%L, %L)',
      t.name, pkcols, excluded
    );
  END LOOP;
END
$$;

SELECT sync_attach_all();

-- Nothing is lost: the audit log, stock ledger and supplier ledger are append-only.
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be changed or deleted', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER supplier_ledger_append_only BEFORE UPDATE OR DELETE ON supplier_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Database safety net: quantities and prices can't go negative, so bad data can't get in
-- even through a bug.
ALTER TABLE stock_balances ADD CONSTRAINT stock_balances_qty_not_negative CHECK (qty >= 0);

ALTER TABLE sub_products ADD CONSTRAINT sub_products_prices_not_negative CHECK (
  market_value >= 0 AND purchase_discount >= 0 AND cost_price >= 0 AND actual_price >= 0
  AND r_price >= 0 AND w_price >= 0 AND sales_discount >= 0 AND sales_price >= 0
);

ALTER TABLE products ADD CONSTRAINT products_pack_values CHECK (
  pieces_per_box >= 1 AND (pack_size IS NULL OR pack_size > 0)
  AND reorder_level >= 0 AND reorder_qty >= 0
);

ALTER TABLE purchase_lines ADD CONSTRAINT purchase_lines_values CHECK (
  qty > 0 AND free >= 0 AND value >= 0 AND discount_per_unit >= 0 AND cost >= 0 AND amount >= 0
  AND actual_price >= 0 AND r_price >= 0 AND w_price >= 0 AND sales_discount >= 0
  AND sales_price >= 0 AND stock_qty > 0 AND returned_qty >= 0 AND returned_qty <= stock_qty
);

ALTER TABLE purchases ADD CONSTRAINT purchases_totals_not_negative CHECK (
  subtotal >= 0 AND invoice_discount >= 0 AND other_charges >= 0 AND net_total >= 0
  AND supplier_invoice_total >= 0 AND paid_amount >= 0 AND returned_amount >= 0
);

ALTER TABLE supplier_ledger ADD CONSTRAINT supplier_ledger_one_side CHECK (
  debit >= 0 AND credit >= 0 AND NOT (debit > 0 AND credit > 0)
);

ALTER TABLE supplier_payments ADD CONSTRAINT supplier_payments_amount CHECK (amount > 0 AND advance >= 0);
ALTER TABLE payment_allocations ADD CONSTRAINT payment_allocations_amount CHECK (amount > 0);

ALTER TABLE sales ADD CONSTRAINT sales_totals_not_negative CHECK (
  total_qty >= 0 AND gross >= 0 AND discount >= 0 AND net_total >= 0 AND cost_total >= 0
  AND refunded_total >= 0 AND (cash_given IS NULL OR cash_given >= 0) AND (change IS NULL OR change >= 0)
);

ALTER TABLE sale_lines ADD CONSTRAINT sale_lines_values CHECK (
  qty > 0 AND unit_price >= 0 AND r_price >= 0 AND discount_per_unit >= 0 AND gross >= 0
  AND discount >= 0 AND amount >= 0 AND cost_price >= 0 AND unit_cost >= 0
  AND returned_qty >= 0 AND returned_qty <= qty AND refunded_amount >= 0 AND refunded_amount <= amount
);

ALTER TABLE sale_returns ADD CONSTRAINT sale_returns_refund CHECK (refund_total >= 0);
ALTER TABLE sale_return_lines ADD CONSTRAINT sale_return_lines_values CHECK (qty > 0 AND amount >= 0 AND unit_cost >= 0);
ALTER TABLE purchase_return_lines ADD CONSTRAINT purchase_return_lines_values CHECK (qty > 0 AND amount >= 0 AND unit_cost >= 0);
ALTER TABLE transfer_lines ADD CONSTRAINT transfer_lines_qty CHECK (qty > 0);
ALTER TABLE transfers ADD CONSTRAINT transfers_different_locations CHECK (from_location_id <> to_location_id);
ALTER TABLE mp_transfers ADD CONSTRAINT mp_transfers_values CHECK (cans > 0 AND liters > 0 AND new_price_per_liter >= new_average_cost);
ALTER TABLE adjustment_lines ADD CONSTRAINT adjustment_lines_qty CHECK (qty <> 0);
ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_amount CHECK (amount > 0);
ALTER TABLE shifts ADD CONSTRAINT shifts_float CHECK (opening_float >= 0);
ALTER TABLE cheques ADD CONSTRAINT cheques_amount CHECK (amount > 0);
