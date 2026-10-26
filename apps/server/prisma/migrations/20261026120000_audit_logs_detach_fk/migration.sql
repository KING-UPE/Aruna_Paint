-- Drop foreign key constraints on audit_logs so the append-only audit trail
-- is not touched when a user without transactions is deleted.
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_user_id_fkey";
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_approver_id_fkey";
