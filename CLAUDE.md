# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read these first

- `docs/POS_System_Plan.pdf` is the requirements spec (33 pages, agreed with the shop owner on 25 Oct 2026). Every business rule in the code comes from it; when unsure, read the relevant section rather than guessing.
- `docs/PROGRESS.md` is the handoff: what is built, decisions taken where the plan was silent, known gaps, and the ordered list of next steps. Read it before starting new work and update it when you finish a piece.

## What this is

A keyboard-first web POS for Pannala Aruna Paint Center (Sri Lanka). One shop server PC runs the API, PostgreSQL, printing and backups; 1–2 billing counters and a stock/admin PC use the screens over the LAN. The same app runs in the cloud (`APP_MODE=cloud`) as the online panel for Admins and the Super Admin, kept in step by two-way sync; the shop works fully offline. Three sections: Stock, Billing, Admin. Four combinable roles: Super Admin, Admin, Stock Manager, Cashier.

## Commands

Requires Node 22, pnpm 10 and PostgreSQL 16 (local role `aruna`/`aruna` with CREATEDB).

```bash
pnpm install
cp apps/server/.env.example apps/server/.env        # DATABASE_URL, PIN_SECRET, PORT
pnpm --filter @aruna/server db:deploy               # apply migrations (prisma migrate deploy)
pnpm db:seed                                        # demo shop on an empty DB (logins below)
pnpm dev                                            # server :3000 (tsx watch) + Vite :5173 (proxies /api and the WebSocket)

pnpm typecheck                                      # tsc in every package
pnpm test                                           # shared unit tests + server integration tests
pnpm --filter @aruna/shared test                    # domain formulas only (fast)
pnpm --filter @aruna/server test                    # integration tests (creates and migrates aruna_test itself)
cd apps/server && npx vitest run test/billing.test.ts -t "day end"   # one file / one test by name
pnpm --filter @aruna/web build                      # needed before e2e
cd apps/web && PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npx playwright test   # keyboard e2e; its webServer step builds a seeded aruna_e2e DB
pnpm format                                         # prettier
```

Seeded logins (password `password123`): `owner` (Super Admin, PIN 1111), `admin` (2222), `stock` (3333), `cashier` (4444). Billing PCs open `http://host:3000/?counter=C1` (the code is remembered in localStorage and sent at login).

New migration: edit `apps/server/prisma/schema.prisma`, then `npx prisma migrate dev --name <name>` in `apps/server`. `prisma migrate reset` refuses to run for an AI agent without the user's consent; for a throwaway local DB, drop and recreate it with `dropdb`/`createdb` and run `prisma migrate deploy` instead.

## Layout

```
packages/shared   @aruna/shared — business rules used by BOTH server and screens (exported as TS source)
apps/server       @aruna/server — Fastify 5 + Prisma 6 on PostgreSQL; serves apps/web/dist in production
apps/web          @aruna/web    — React 19 + Vite 7 + Tailwind 4, TanStack Query/Table, RHF + Zod, cmdk, Radix Dialog
docs/             plan PDF and PROGRESS.md
```

## Architecture you need to know

**Shared rules, priced twice.** `packages/shared/src/domain/*` holds every formula from the plan (purchase line, discount caps, FIFO batch allocation and the multi-price pop-up rule, qty-box parsing where `1` is a can and `1L`/`0.375` is loose, mix paint weighted average, return refunds, monthly closing, supplier balance, reorder, number formats, permissions, shortcut key maps). The screens use them to show live totals; the server re-runs them on every write and never trusts prices sent by the client. `packages/shared/src/schemas/*` are the Zod request schemas used by both sides. Unit tests in `packages/shared/test` replay the plan's worked examples. Change a rule there first.

**Money and quantities.** `Decimal` from `@aruna/shared` (decimal.js clone, half-up). DB columns are `Decimal(14,2)` / `Decimal(14,3)`. API values are strings (`"1250.00"`, `"1.500"`). Never use JS floats for money.

**Database rules** (`apps/server/prisma/`):

- IDs are UUIDv7. Prisma generates them for its own inserts; raw SQL must pass `uuidv7()` from `src/lib/ids.ts` and set `updated_at` itself.
- Stock is a ledger: change stock only through `moveStock()` in `src/core/stock.ts`. It updates the cached `stock_balances` row and writes `stock_movements` in the caller's transaction. Out-moves are conditional row-locked UPDATEs, so two counters can't sell the last can. A CHECK keeps balances ≥ 0.
- `audit_logs`, `stock_movements` and `supplier_ledger` are append-only (DB triggers). `audit_logs` has no foreign keys to `users` (migration `..._audit_logs_detach_fk`), but Prisma still wants to add them back. **Delete those `AddForeignKey` lines from every new migration** `migrate dev` writes. Records with history are deactivated, never deleted.
- Migration `..._sync_outbox_and_constraints` adds `sync_capture()` triggers that copy every row change into `sync_outbox` inside the same transaction (`users.pin_hmac` is stripped; `sessions`, `recovery_codes`, `sync_*` are excluded). **Any migration that adds a table must end with `SELECT sync_attach_all();`.** Prisma ignores triggers and CHECK constraints, so `migrate dev` won't drop them.
- Readable numbers (INV-, GRN-, SUP-…) come from `nextNumber()` in `src/core/numbering.ts`. It runs inside the caller's transaction, so a failed bill gives its number back and numbers stay gap-free. Formats use brace tokens (`INV-{NNNNNN}`, `GRN-{YYYY}-{NNNNN}`, `DE-{YYYY}{MM}{DD}-{COUNTER}`) so literal letters stay literal.
- Dates follow the shop time zone `Asia/Colombo` (`shopDate()`); calendar columns are `@db.Date` (use `parseDateOnly`/`dateOnly` from `src/lib/json.ts`).

**Server request flow.** `src/auth/session.ts` loads the session on every `/api` request into `req.ctx` (user, combined permissions, counter, location). It enforces the idle lock (HTTP 423; background polls send `X-Passive: 1` so they don't count as activity) and forced password changes. Routes opt out with `config: { public | allowLocked | allowPasswordChange }`. Guard routes with `preHandler: perm('module.action')`. Writes also take `shopOnly()`: in cloud mode only the routes in `ONLINE_CHANGES` (`modules/sync/online.ts`) may write. Services are `(tx, ctx/actor, input)` functions run in `db.$transaction(fn, TX_OPTIONS)`. Throw `DomainError(code, plainWordsMessage, field?)`. `field` paths like `lines.2.qty` let the screens put the message under that field. Warnings the user may override come back as 409 with `details.warning = true` (plus `details.confirm` naming the flag to resend). Write `audit()` in the same transaction.

**Approvals (manager override).** `requireApproval(tx, ctx, kind, approval?.pin, pinSecret)` (`src/auth/approvals.ts`; kinds in shared `APPROVALS`) passes if the user holds the permission. Otherwise it needs another user's PIN; PINs are HMAC'd, unique, and identify the approver. The screens use `usePinPrompt()` and `/api/auth/verify-approval`.

**Permissions.** `rolePermissions()` and `resolvePermissions()` in shared:

- Built-in roles use the code defaults unless `roles.customized` is set; then they use the stored list.
- Custom roles use their stored list. The Super Admin role always has everything.
- Each user's `user_permissions` rows then add or take away single permissions, never Super Admin-only ones.
- The server loads all of this in `auth/permissions.ts`. The editor screen is `admin/PermissionEditor.tsx`.

**Months.** Sales months start on `closing.monthStartDay` (chosen on the HRM page). Use `monthPeriod` and `periodContaining` from `shared/domain/periods.ts` for any monthly figure.

**Product renames** rewrite the code and name on old `sale_lines` (`renameOnOldBills` in `modules/products/service.ts`) and log `product.rename`. The Super Admin sees the history on the product page.

**Cost privacy.** Each product's cost/actual/margin needs `cost.item` (Stock Manager, Super Admin). Totals need `cost.totals` (Super Admin only). Serializers drop those fields (`canSeeItemCost(req)`). Billing lookups never send cost; they send `maxDiscount = min(purchase discount, R-price − cost)`.

**Test mode is per user** (`src/core/testmode.ts`, `src/core/dbscope.ts`). The Super Admin puts single accounts (`users.test_mode`) on a copy of the data (`<db>_testmode`, built from the migration files plus a row copy, no `pg_dump`), while everyone else works on the real data. `app.deps.db` is a proxy (`scopedDb`): each request runs in an `AsyncLocalStorage` scope, and the session hook calls `useTestData()` for a test-mode user, so routes keep using `db` as usual. `/api/auth/*` always stays real. Code that caches database rows in memory must keep one cache per scope (`inTestData()`, as `SettingsService` does). Records that must stay real go to `testMode.production`. On the copy, `nextNumber()` adds `TEST-`, `PrintService` stamps every slip and drops the drawer kick, and backups don't run.

**Cloud sync** (`core/syncagent.ts`, `core/syncapply.ts`, `modules/sync/`). The shop's agent sends `sync_outbox` to the cloud every 15 s, and the cloud mirrors each row once. A write on the online panel runs the normal route on the cloud's copy; `registerCloudCapture` records the rows it changed as a `sync_commands` row. The shop applies those changes field by field (`findConflicts`, `mergeChange`) or holds a conflict for the Super Admin. A new route that should work online goes in `ONLINE_CHANGES`; anything that moves stock or money stays out. Code that writes rows outside a captured route in cloud mode diverges from the shop.

**Side effects after commit.** Receipts (ESC/POS in `src/printing/`) print after the transaction commits; a printer error never undoes a sale. Live updates go through `EventBus` → `/api/live` WebSocket → the web app invalidates queries. Day-end backups (`src/core/backups.ts`, `pg_dump`) run in the background.

**Web app.** `src/keyboard/keymap.tsx` is the single keyboard listener. Screens register actions with `useHotkeys(screen, handlers, { enabled, inDialog, whileTyping })`, and the user's remapped keys (from `/api/auth/me`) decide which key fires. Single-letter keys don't fire while typing in an input. The billing screen (`src/billing/`) is full screen; `ItemEntry.tsx` runs the item → (batch picker) → qty → discount or price-per-liter flow, and `bill.ts` prices lines with the shared rules. Other screens sit inside `layout/AppLayout.tsx` with a permission-filtered sidebar.

## Gotchas learned the hard way

- Colours come only from the theme tokens in `index.css` (`bg-accent`, `text-muted`, `border-border`…). Never use Tailwind palette colours (`bg-teal-600`) or hex codes in screens: the Super Admin's colour theme (`lib/theme.ts`, `shared/domain/themes.ts`) rewrites the tokens.
- Row actions in tables (edit, reset, delete…) use `IconButton` (`components/ui/icon-button`) with a `label`, not word buttons. Other buttons take an `icon` prop beside their words.
- Charts: use `components/charts/charts.tsx` (`TrendChart`, `ColumnChart`, `BarList`, `ChartCard` with a table view), not a chart library. Dialogs get arrow-key movement between buttons from `Dialog` (`lib/arrowNav.ts`); add `onKeyDown={arrowNav}` to other button rows.
- Nothing a cashier rang up may vanish: never hard-delete a sale. Held bills and quotations become `DELETED` with a reason (`deleteBillSchema`). New ways to take something off a bill must log it (see `bill.lines_removed`).
- List rows follow the mouse with `onMouseMove`/`onPointerMove`, never `onMouseEnter`. A list opening under a resting pointer would otherwise change what Enter picks.
- "Type to find" boxes use `Combobox` (`components/ui/combobox.tsx`; value lists use `ValueSelect`), never a hand-made suggestion list. It clears unpicked text on leaving and offers "+ Add" through `onAdd`.
- Use `Select` from `components/ui/input` (our dropdown), never a native `<select>`. Use `useConfirm()` and `useAsk()` from `components/AskDialog`, never `window.confirm` or `window.prompt`. A `Checkbox` takes `indeterminate`.
- React's `autoFocus` does nothing on a `div`. Dialog lists need `initialFocus` on our `Dialog`, and its Close button is out of the tab order. Pass `restoreFocus={false}` when the caller moves focus on after closing.
- Move focus with a `useLayoutEffect` after state changes, not `requestAnimationFrame`. Cashiers (and Playwright) type the next key immediately.
- In the history dialog, P/R/C/V only work once Enter has moved focus from the search box to the list.
- Suggestions must match exactly what is typed now (`debounced === query` in `ItemEntry.tsx`). Stale results plus a fast Enter would pick the previous item.
- `pkill -f "tsx src/index.ts"` matches your own shell command. Find the PIDs with `ps aux | grep "[c]li.mjs src/index"` and `kill` them. Playwright needs port 3100 free (`reuseExistingServer` is off).
- Tests set `ARUNA_SCRYPT_N=1024` for speed. Password hashes store their own cost, so this is safe.
- User-facing messages are plain words for shop staff, in the plan's wording; code comments quote the rule they implement.
