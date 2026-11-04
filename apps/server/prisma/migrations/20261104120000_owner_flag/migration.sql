-- The owner: the one top Super Admin, the same account at every shop. Only the owner changes it.
ALTER TABLE "users" ADD COLUMN "owner" BOOLEAN NOT NULL DEFAULT false;
