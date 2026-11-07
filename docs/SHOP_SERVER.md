# The shop server PC

One PC in the shop runs the server and the database; every other PC opens the screens from it over
the shop network. All PCs are the same: there are no counters, and every bill and change is
recorded under the user who signed in.

## Installing it (Windows 10 or 11, 64-bit)

1. Download `ArunaPOS-Setup-<version>.exe` from the project's GitHub releases
   (`https://github.com/KING-UPE/Aruna_Paint/releases/latest`).
2. Run it on the shop's main PC and click **Next**, **Install**, wait (a few minutes), **Finish**.
   Nothing else needs installing first: it brings its own Node.js, PostgreSQL 16 and the Visual
   C++ runtime.
   - Windows may show "Windows protected your PC" because the installer isn't signed with a
     code-signing certificate yet: click **More info → Run anyway**.
3. The **Aruna POS** icon on the desktop opens the screens. The first visit runs the first-run
   wizard: the shop's details and the online panel's address and shop key. No account is made:
   the owner's arrives with the first sync (about a minute) and the owner signs in with their usual
   username and password. A shop without the online panel makes its own Super Admin there instead.
   **The database starts empty: no demo data, no other users.**
4. Every other PC in the shop opens `http://<server-pc-name>:3000` in Edge or Chrome (the finish
   page shows the address). In Edge, **⋯ → Apps → Install this site as an app** gives that PC its
   own icon.

What the installer sets up:

| What | Where |
| --- | --- |
| Program (Node.js, PostgreSQL, server, screens) | `C:\Program Files\Aruna POS` |
| The shop's data, backups, logs, settings file | `C:\ProgramData\ArunaPOS` (only Administrators can open it) |
| Database | PostgreSQL service **ArunaPOS-DB**, port 5544, this PC only |
| Server | service **ArunaPOS-Server**, port 3000, starts with Windows, restarts itself if it stops |
| Firewall | port 3000 open to the shop's own network only |
| Updates | scheduled task **Aruna POS Updater** (started by the server) |

The settings file `C:\ProgramData\ArunaPOS\config.env` holds the database passwords and the PIN
secret. Keep a copy somewhere safe: losing `PIN_SECRET` means setting every PIN again.

PINs set on the online panel work at a shop only if both use the same PIN secret. A new shop
linked to the online panel in the first-run wizard takes the panel's secret by itself with its
first sync (before any PIN exists there), and keeps using it. A shop that already had PINs keeps
its own secret, and Admin → Cloud sync says that PINs set online don't work there. To give a shop
the panel's secret from the start anyway, install with
`ArunaPOS-Setup-<version>.exe /PINSECRET=<the online panel's PIN_SECRET>`.

Silent install (for IT): `ArunaPOS-Setup-<version>.exe /S`.

## Updates (automatic)

The server checks the GitHub releases every 15 minutes (and when it starts). A newer version is downloaded and checked
(SHA-256), then installed by itself at the time set in **Settings → Software updates** (02:30 by
default), or straight away when the Super Admin presses **Install**. Each update:

1. **backs up the database** to `C:\ProgramData\ArunaPOS\data\backups\before-update-<from>-to-<to>-<time>.dump`;
2. stops the server, swaps in the new program, applies the database changes;
3. starts the server and checks it answers as the new version;
4. if any step fails, puts the old program **and the backed-up database** back and starts the old
   version again. The Super Admin sees what happened on the Software updates card, in the audit log
   (`update.installed` / `update.failed`) and as an alert.

Running a newer `ArunaPOS-Setup-<version>.exe` by hand does exactly the same. The online panel on
Vercel updates by itself when the code reaches `main`.

### Publishing a new version (developer)

1. Raise `"version"` in every `package.json` (root, `apps/server`, `apps/web`, `packages/shared`),
   for example to `1.0.2`, and merge to `main`.
2. On GitHub: **Actions → Windows installer → Run workflow**, branch `main`, tick **publish**, Run.
   (Pushing a tag `v1.0.2` does the same.)
3. The workflow (`.github/workflows/installer.yml`) builds the installer, installs it on a clean
   Windows machine and tests a fresh install, first-run setup, an update over it, the automatic
   updater, uninstall and reinstall. Only if all of that passes does it publish the GitHub release
   (and its tag) that the shops update from.

To build the installer yourself: `node installer/build.mjs` (needs `makensis` from NSIS and
internet; writes `dist/ArunaPOS-Setup-<version>.exe` and `dist/latest.json`).

## Uninstalling

Windows Settings → Apps → **Aruna POS** → Uninstall. It asks whether to delete the shop's data;
the answer **No** (the default) keeps the database and backups, and installing again later brings
them back.

## If something goes wrong

- **Logs:** `C:\ProgramData\ArunaPOS\logs` (`setup-*.log`, `updater-*.log`, `ArunaPOS-Server.*.log`).
- **The screens don't open:** Windows Services → check **ArunaPOS-DB** and **ArunaPOS-Server** are
  Running (Start them if not).
- **Restore a backup by hand** (server stopped, in `C:\Program Files\Aruna POS\pgsql\bin`):
  `pg_restore --clean --if-exists --no-owner -h 127.0.0.1 -p 5544 -U aruna -d aruna_pos <backup file>`
  (the password is in `config.env`).

## Without the installer (from the source code)

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

Keep that window open: closing it stops the server. To update a source install, stop the server
when nobody is billing and run `pnpm shop:update`: it checks the folder is a clean copy of `main`,
backs the data up to `apps/server/data/backups/aruna-<date>-pre-update.dump`, pulls, installs,
builds and applies the database changes, stopping at the first failure. If `pg_dump` isn't found,
set `PG_BIN_DIR` in `apps/server/.env`, for example `PG_BIN_DIR="C:/Program Files/PostgreSQL/16/bin"`.
