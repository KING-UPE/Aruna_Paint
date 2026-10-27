-- A held bill or a quotation that is taken away is kept as DELETED with who, when and why,
-- so nothing rung up can disappear without a trace.
-- (audit_logs has no foreign keys to users on purpose; see ..._audit_logs_detach_fk.)

-- AlterEnum
ALTER TYPE "SaleStatus" ADD VALUE 'DELETED';

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "delete_reason" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "deleted_at" TIMESTAMPTZ(3),
ADD COLUMN     "deleted_by_id" UUID;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_deleted_by_id_fkey" FOREIGN KEY ("deleted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
