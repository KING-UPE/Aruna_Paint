# The online panel on Vercel

The online panel is this same app in cloud mode. On Vercel it runs as one function for `/api`,
with the screens served as static files. It needs a PostgreSQL database. Neon, from Vercel's
Storage tab, fits: it grows with your plan, and it lets the app make one database per shop.

How it is built: `vercel.json` runs `apps/server/scripts/vercel-build.mjs`. The script writes
`.vercel/output` (Vercel's Build Output API):

- the screens;
- the server bundled into one function, with Prisma and the migrations;
- the routes (`/api/*` to the function, everything else to the screens).

It also runs the migrations on the cloud's own database.

## 1. Database (Neon, through Vercel)

1. In Vercel, open the project (or create it first, step 2) → **Storage** → **Create Database** →
   **Neon**.
2. Pick the region **Singapore (ap-southeast-1)**, the nearest to Sri Lanka. The functions run in
   Singapore too (`"regions": ["sin1"]` in `vercel.json`).
3. Connect it to the project for all environments. This adds `DATABASE_URL` (pooled, for
   requests) and `DATABASE_URL_UNPOOLED` (direct, for making databases and migrations). The app
   reads both by itself.

**How big it gets.** The cloud keeps one database per shop. A rough guess for one busy shop
(about 300 bills a day) is 1–2 GB a year, with bills, stock movements and the activity log.
Neon's free plan is small. Its paid plans add storage as the data grows, and you can move up
any time without changing anything here. Check Neon's current plans when you sign up.

## 2. Project

1. **Add New → Project** → import the GitHub repository `king-upe/aruna_paint`.
2. Root Directory: leave it at the repository root. Framework Preset: **Other**. `vercel.json`
   sets the install and build commands.

## 3. Environment variables (Production)

| Name         | Value                                                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `APP_MODE`   | `cloud`                                                                                                                       |
| `SYNC_KEY`   | A long random string. Every shop enters the same text as its "Shop key".                                                      |
| `PIN_SECRET` | **Exactly the same** as the shops' `PIN_SECRET`, or PINs reset online won't work there. Use the same secret at every shop. |
| `DATA_DIR`   | `/tmp`                                                                                                                        |
| `LOG_LEVEL`  | `warn`                                                                                                                        |

`DATABASE_URL` and `DATABASE_URL_UNPOOLED` come from step 1.

## 4. Deploy

Deploy (or push to `main`). The build:

1. builds the screens;
2. makes Prisma's client;
3. runs the migrations on the cloud database;
4. bundles the function.

Open `https://<project>.vercel.app`. The sign-in page says it is waiting for the first shop.

## 5. Link each shop

At each shop, the Super Admin opens **Settings → Cloud mirror**:

- **Cloud address:** `https://<project>.vercel.app`
- **Shop key:** the `SYNC_KEY` from step 3

Within 15 seconds the shop appears on the online panel's sign-in page. The first sync of a shop
with a long history can take a few minutes; the status bar shows the changes still waiting.
Each shop gets its own database the first time it connects (`<database>_s_<id>`). After an app
update, every shop's database takes the new migrations the next time it is opened.

## Good to know

- The online panel refreshes on a timer (every 15 s) instead of the shop's live updates; Vercel
  functions don't keep a WebSocket open.
- Sign-in: choose the shop, then the username and password used at that shop. Only users with
  "Open the online panel" get in.
- Nothing about billing changes: each shop keeps working offline, and syncs when it is online.
