-- When the cloud's copy of a shop last started again from a full copy of the shop. A shop the
-- cloud has no full copy of is asked to send one.
ALTER TABLE "sync_nodes" ADD COLUMN "full_copy_at" TIMESTAMPTZ(3);

-- A full copy of the shop for the cloud: a marker telling the cloud to empty its copy, then every
-- synced row, parents before children, shaped exactly like the rows sync_capture() queues (each
-- table's key and hidden columns come from its own trigger). Unsent changes are replaced by the
-- copy, and the outbox stays locked meanwhile, so no change slips between the copy and the queue.
CREATE OR REPLACE FUNCTION sync_full_copy() RETURNS integer
LANGUAGE plpgsql SET timezone TO 'UTC' AS $$
DECLARE
  remaining text[];
  ordered text[] := '{}';
  progress boolean;
  t text;
  args text;
  pkcols text;
  hidden text;
  total integer := 0;
  n integer;
BEGIN
  SELECT coalesce(array_agg(c.relname::text ORDER BY c.relname), '{}') INTO remaining
    FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
   WHERE tg.tgname = 'zz_sync_capture' AND NOT tg.tgisinternal;
  -- Parents before children: a table goes once every table it points at (but itself) has gone.
  LOOP
    progress := false;
    FOREACH t IN ARRAY remaining LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint k
          JOIN pg_class ch ON ch.oid = k.conrelid
          JOIN pg_class pa ON pa.oid = k.confrelid
         WHERE k.contype = 'f' AND ch.relname = t AND pa.relname <> t
           AND pa.relname = ANY (remaining)
      ) THEN
        ordered := ordered || t;
        remaining := array_remove(remaining, t);
        progress := true;
      END IF;
    END LOOP;
    EXIT WHEN cardinality(remaining) = 0 OR NOT progress;
  END LOOP;
  -- Tables that point at each other, if any, go last; the cloud retries rows whose parent is late.
  ordered := ordered || remaining;

  LOCK TABLE sync_outbox IN EXCLUSIVE MODE;
  DELETE FROM sync_outbox WHERE sent_at IS NULL;
  INSERT INTO sync_outbox (table_name, op, pk, data, old) VALUES ('__full_copy__', 'INSERT', '{}', '{}', NULL);
  FOREACH t IN ARRAY ordered LOOP
    SELECT encode(tg.tgargs, 'escape') INTO args
      FROM pg_trigger tg WHERE tg.tgrelid = t::regclass AND tg.tgname = 'zz_sync_capture';
    pkcols := split_part(args, '\000', 1);
    hidden := split_part(args, '\000', 2);
    EXECUTE format(
      'INSERT INTO sync_outbox (table_name, op, pk, data, old)
       SELECT %L, ''INSERT'',
              (SELECT jsonb_object_agg(k, r.j -> k) FROM unnest(string_to_array(%L, '','')) AS k),
              r.j - string_to_array(%L, '',''), NULL
         FROM (SELECT to_jsonb(x) AS j FROM %I AS x ORDER BY %s) AS r',
      t, pkcols, hidden, t,
      (SELECT string_agg(quote_ident(c), ', ') FROM unnest(string_to_array(pkcols, ',')) AS c));
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;
  RETURN total;
END
$$;
