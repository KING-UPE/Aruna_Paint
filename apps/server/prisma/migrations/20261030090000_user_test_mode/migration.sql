-- Test mode is per user: the Super Admin puts single accounts on the test copy.
ALTER TABLE "users" ADD COLUMN "test_mode" BOOLEAN NOT NULL DEFAULT false;
