-- AlterTable
ALTER TABLE "roles" ADD COLUMN     "customized" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "user_permissions" (
    "user_id" UUID NOT NULL,
    "permission" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,

    CONSTRAINT "user_permissions_pkey" PRIMARY KEY ("user_id","permission")
);

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- audit_logs keeps no foreign keys to users (see 20261026120000_audit_logs_detach_fk) so users
-- without history can be deleted while their log rows stay. Prisma keeps proposing to re-add them;
-- leave them out of every migration.

SELECT sync_attach_all();
