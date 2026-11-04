# The shop server PC

One PC in the shop runs the server and the database; every other PC opens the screens from it over
the shop network. All PCs are the same: there are no counters, and every bill and change is
recorded under the user who signed in. There is no installer or automatic update yet (they are
on the plan's list), so the steps below are done by hand, in a terminal in the project folder.

## Once: setting it up

Needs Node 22, pnpm 10, Git and PostgreSQL 16 on the PC.

```bash
git clone https://github.com/king-upe/aruna_paint.git
cd aruna_paint
pnpm install
copy apps\server\.env.example apps\server\.env     # (cp on Linux/macOS) then edit it:
#   DATABASE_URL  the shop's PostgreSQL database
#   PIN_SECRET    a long random text; keep it safe, the same one the cloud uses
pnpm build
pnpm --filter @aruna/server db:deploy
pnpm shop:start
```

The first visit to `http://<server-pc>:3000` runs the first-run wizard. Every other PC opens the same
address. Receipts print on the one printer set in Settings → Receipt printer.

## Every day: starting it

```bash
pnpm shop:start
```

Keep that window open: closing it stops the server. The screens come from the same server, so
nothing else needs starting.

## Updating it

Close the server's window (or stop its service) when nobody is billing, then in the project folder:

```bash
pnpm shop:update
```

It does, in order, and stops at the first step that fails:

1. checks this folder is a clean copy of `main` (changes made on this PC would stop it);
2. **backs up the data** to `apps/server/data/backups/aruna-<date>-pre-update.dump`;
3. gets the latest code (`git pull`), installs packages and builds the server and the screens;
4. applies the database changes.

Then start the server again (`pnpm shop:start`) and reload each PC (F5). The online panel on Vercel
updates by itself when the code reaches `main`; each shop's copy there takes the database changes
the next time it is opened.

If PostgreSQL's `pg_dump` isn't found, set `PG_BIN_DIR` in `apps/server/.env`, for example
`PG_BIN_DIR="C:/Program Files/PostgreSQL/16/bin"`.

## If an update goes wrong

The update prints the version it came from (for example `a9bceb7 → b8cfd81`) and the backup file.

- **It stopped before "Applying database changes":** the data wasn't touched. Fix what it says and
  run it again, or go back with `git checkout <old version>`, `pnpm install` and `pnpm build`.
- **The new version misbehaves after the database changes:** put the backup back. With the server
  stopped: `pg_restore --clean --if-exists --no-owner --dbname=<DATABASE_URL without ?schema=public> <backup file>`.
  Then go back to the old version as above.
