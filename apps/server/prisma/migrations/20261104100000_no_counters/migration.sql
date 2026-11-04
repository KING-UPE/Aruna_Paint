-- Every PC is the same (the shop's request): no counters. Bills, returns and days belong to the
-- shop and to the user who made them; old ones keep their counter for history.
ALTER TABLE "sales" ALTER COLUMN "counter_id" DROP NOT NULL;
ALTER TABLE "sale_returns" ALTER COLUMN "counter_id" DROP NOT NULL;
ALTER TABLE "shifts" ALTER COLUMN "counter_id" DROP NOT NULL;
ALTER TABLE "sales" DROP CONSTRAINT "sales_counter_id_fkey";
ALTER TABLE "sales" ADD CONSTRAINT "sales_counter_id_fkey" FOREIGN KEY ("counter_id") REFERENCES "counters"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sale_returns" DROP CONSTRAINT "sale_returns_counter_id_fkey";
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_counter_id_fkey" FOREIGN KEY ("counter_id") REFERENCES "counters"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "shifts" DROP CONSTRAINT "shifts_counter_id_fkey";
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_counter_id_fkey" FOREIGN KEY ("counter_id") REFERENCES "counters"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- One day per date for the whole shop (the server takes a lock while opening it).
DROP INDEX IF EXISTS "shifts_counter_id_business_date_key";
CREATE INDEX "shifts_business_date_idx" ON "shifts"("business_date");

-- Day end numbers are one per date: the counter code goes from every format.
UPDATE "number_formats"
   SET "format" = replace(replace("format", '-{COUNTER}', ''), '{COUNTER}', ''), "updated_at" = now()
 WHERE "format" LIKE '%{COUNTER}%';

-- The shop's receipt printer is the first counter's printer.
INSERT INTO "settings" ("key", "value", "updated_at")
SELECT 'printer', c."printer", now() FROM "counters" c
 WHERE c."active" AND c."printer"->>'driver' <> 'none'
 ORDER BY c."code" LIMIT 1
ON CONFLICT ("key") DO NOTHING;

-- Days still open on counters: today's first one becomes the shop's day and the others' bills
-- join it; days from earlier dates close with their totals.
DO $$
DECLARE
  today date := (now() AT TIME ZONE 'Asia/Colombo')::date;
  keep uuid;
BEGIN
  SELECT id INTO keep FROM "shifts"
   WHERE "status" = 'OPEN' AND "business_date" = today ORDER BY "opened_at" LIMIT 1;
  IF keep IS NOT NULL THEN
    UPDATE "sales" SET "shift_id" = keep, "updated_at" = now()
     WHERE "shift_id" IN (SELECT id FROM "shifts" WHERE "status" = 'OPEN' AND "business_date" = today AND id <> keep);
    UPDATE "sale_returns" SET "shift_id" = keep
     WHERE "shift_id" IN (SELECT id FROM "shifts" WHERE "status" = 'OPEN' AND "business_date" = today AND id <> keep);
    UPDATE "shifts" SET "counter_id" = NULL WHERE id = keep;
  END IF;
  UPDATE "shifts" s
     SET "status" = 'CLOSED', "closed_at" = now(),
         "note" = 'Closed when counters were removed.',
         "cash_sales" = COALESCE((SELECT sum("net_total") FROM "sales"
                                   WHERE "shift_id" = s.id AND "kind" = 'INVOICE' AND "status" = 'COMPLETED'), 0),
         "cash_refunds" = COALESCE((SELECT sum("refund_total") FROM "sale_returns" WHERE "shift_id" = s.id), 0)
   WHERE s."status" = 'OPEN' AND (keep IS NULL OR s.id <> keep);
END $$;
