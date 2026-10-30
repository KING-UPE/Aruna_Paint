-- The cloud serves several shops: each shop's data lives in its own database, listed here.
ALTER TABLE "sync_nodes" ADD COLUMN "db_name" TEXT NOT NULL DEFAULT '';
