-- Two-way sync with the online panel.

-- The row before an update or delete travels with the change, so an online change can be checked
-- field by field against what the shop changed meanwhile.
ALTER TABLE "sync_outbox" ADD COLUMN "old" JSONB;

-- Captured rows are written in UTC, so the shop and the cloud write timestamps the same way. A
-- change being applied from the other side (aruna.sync_apply) is not captured again.
CREATE OR REPLACE FUNCTION sync_capture() RETURNS trigger
LANGUAGE plpgsql SET timezone TO 'UTC' AS $$
DECLARE
  row_data jsonb;
  old_data jsonb;
  pk jsonb := '{}'::jsonb;
  col text;
BEGIN
  IF current_setting('aruna.sync_apply', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    row_data := to_jsonb(OLD);
  ELSE
    row_data := to_jsonb(NEW);
  END IF;
  IF TG_OP = 'UPDATE' AND to_jsonb(OLD) = row_data THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    old_data := to_jsonb(OLD);
  END IF;
  FOREACH col IN ARRAY string_to_array(TG_ARGV[0], ',') LOOP
    pk := pk || jsonb_build_object(col, row_data -> col);
  END LOOP;
  -- Columns that never leave the shop (TG_ARGV[1], comma-separated).
  IF TG_ARGV[1] <> '' THEN
    row_data := row_data - string_to_array(TG_ARGV[1], ',');
    old_data := old_data - string_to_array(TG_ARGV[1], ',');
  END IF;
  INSERT INTO sync_outbox (table_name, op, pk, data, old)
  VALUES (TG_TABLE_NAME, TG_OP, pk, CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE row_data END, old_data);
  RETURN NULL;
END
$$;

-- One row as JSON (in UTC, like the captured rows), found by its primary key.
CREATE OR REPLACE FUNCTION sync_row(tbl regclass, pk jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET timezone TO 'UTC' AS $$
DECLARE
  cond text;
  result jsonb;
BEGIN
  SELECT string_agg(format('t.%I = k.%I', key, key), ' AND ') INTO cond
    FROM jsonb_object_keys(pk) AS key;
  EXECUTE format(
    'SELECT to_jsonb(t) FROM %s t, jsonb_populate_record(NULL::%s, $1) k WHERE %s',
    tbl, tbl, cond
  ) INTO result USING pk;
  RETURN result;
END
$$;

-- Every sync_* table stays where it is.
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
      AND c.relname NOT LIKE 'sync\_%'
      AND c.relname NOT IN ('sessions', 'recovery_codes', '_prisma_migrations')
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

-- CreateTable
CREATE TABLE "sync_commands" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "created_by_name" TEXT NOT NULL DEFAULT '',
    "route" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "changes" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decision" TEXT,
    "decided_by_id" UUID,
    "decided_by_name" TEXT NOT NULL DEFAULT '',
    "decided_at" TIMESTAMPTZ(3),
    "message" TEXT NOT NULL DEFAULT '',
    "conflicts" JSONB,
    "processed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sync_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_nodes" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3),
    "last_push_at" TIMESTAMPTZ(3),
    "last_change_id" BIGINT NOT NULL DEFAULT 0,
    "waiting" INTEGER NOT NULL DEFAULT 0,
    "version" TEXT NOT NULL DEFAULT '',
    "info" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sync_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sync_commands_status_idx" ON "sync_commands"("status");

SELECT sync_attach_all();
