# Build progress and handoff

Last updated: 30 Oct 2026, after per-user test mode (working on `main`).
This file is for whoever continues the work: a person or a new Claude session. The spec is `docs/POS_System_Plan.pdf`; section names below match the plan's headings.

## State in one paragraph

Phase 1 ("go-live core") is mostly built and tested end to end. The shared rules, data model, server API, and screens for Billing, Stock and Admin all work against a real PostgreSQL database. What Phase 1 still lacks is the shop-install work: the Windows installer, automatic updates, data import from the old system, Sinhala receipts, and the restore wizard. Phase 2 (reports, closing, reorder, cloud) and Phase 3 have not started, but the database tables for most of them already exist.

Test status on 30 Oct 2026: `pnpm typecheck` is clean; 86 shared unit tests, 96 server integration tests and 10 Playwright keyboard e2e tests all pass. The tests follow the owner's later changes on `main` (see "Owner's changes the tests now follow" below).

## Phase 1 checklist (plan § "Build phases and go-live")

Legend: ✅ done and tested · 🟡 partly done · ⬜ not started

### Foundation
- ✅ Login with username + password; PIN user switching; idle screen lock (client timer + server enforcement); forced password change after reset; 8 printed recovery codes for the Super Admin.
- ✅ Roles by checkbox (combined per user), custom roles built from module permissions, safety rules (an active Super Admin always remains; Super Admin-only permissions can't go into a custom role), and server-side permission checks on every route.
- ✅ Per-permission control. The Super Admin opens a role to see its permissions:
  - Built-in roles (not the Super Admin) can be changed for everyone who has them (`roles.customized`) and put back with "Back to default" (`POST /api/roles/:id/reset`).
  - Each user can also get extra permissions, or lose some, on top of their roles (`user_permissions`, sent as `permissionOverrides`).
  - The rule lives in `shared/domain/permissions.ts` (`rolePermissions`, `resolvePermissions`), and the screen is `admin/PermissionEditor.tsx`.
- ✅ Manager override by PIN, with both names in the audit log (void, mix price change, open can, write-off, old-system return, reverse purchase).
- ✅ Per-user shortcut keys: remap in My profile, validation against reserved and already-used keys, reset to default, F1 help, Ctrl+K command palette.
- ✅ Value manager: categories, brands, units (with an allows-decimal flag), locations (Super Admin only), reasons (with "applies to"), cutoff types. Unique names ignoring case and spaces, merge with history, deactivate when in use, ordering. Missing values are added from the picker itself (see "Pickers" under Look and feel).
- ✅ Audit log: written in the same transaction as each change; append-only at the database level; viewer with filters and before/after values.
- ✅ Sync outbox written from day one by DB triggers in the same transaction. The sync agent that pushes it to the cloud does not exist yet (Phase 2).
- 🟡 Backups: `pg_dump` at day end and nightly (`backup.nightlyAt`), keeping 30 daily and 12 monthly copies, optional second folder, failure alerts, manual backup API, backup list. **Missing:** a cloud copy, the restore wizard, the monthly test-restore reminder, and a UI to start a backup.
- ⬜ Windows installer (Inno Setup/NSIS; Node and PostgreSQL as services) and first-run wizard polish. The first-run wizard itself exists (`/api/setup` and `SetupPage`).
- ⬜ Automatic updates (signed release feed, download, backup first, migrate, health check, roll back).
- ⬜ Data import: Excel templates for suppliers, products and opening stock; a go-live stock count.
- ✅ Settings (shop, receipt, billing, closing, alerts, backup, cloud), number formats (letters allowed), counters with printer settings.
- ✅ **Test mode, per user** (the Super Admin switches single accounts with the flask button in Users and roles; Settings → Test mode lists who is testing and has "Refresh test copy"; `core/testmode.ts`, `core/dbscope.ts`, `POST /api/users/:id/test-mode`, `/api/test-mode`):
  - Users in test mode work on a copy of the data (`<db>_testmode`) while everyone else keeps working on the real data at the same time. Each request picks its database: `deps.db` is a proxy (`scopedDb`) that reads the request's scope from `AsyncLocalStorage`, and the session hook moves test-mode users to the copy. Signing in, the lock and the user's own account (`/api/auth/*`) always stay real. A Super Admin can't be put in test mode.
  - The copy is built by the server itself, with no `pg_dump`: a new database, the same migration files a shop install runs (`core/sqlsplit.ts` splits them), then every row copied in one consistent snapshot (foreign keys off during the load, back on after). Logins and the sync queue are not copied. The first user switched on gets a fresh copy; others join it; "Refresh test copy" starts again from the real data.
  - On the copy: receipts print "TEST MODE - NOT A REAL BILL" at the top and bottom (`stampTest` in `printing/escpos.ts`), numbers start with `TEST-`, the cash drawer never opens, and backups don't run. The user's screens show a red frame and a "TEST MODE" tab (`components/TestModeBanner.tsx`, from `me.testMode`). Settings are cached separately for the copy.
  - The switch stays on (even across a restart) until the Super Admin turns it off. The real audit log keeps `testmode.user_on`, `testmode.user_off` (with that user's test bill count and total) and `testmode.refresh`; the dashboard counts users put in test mode.

### Stock
- ✅ Suppliers: auto SUP- codes, 1–3 phones in one format, reps, similar-name warning, credit days, opening balance (locked once entries exist), deactivate.
- ✅ Supplier activity log: opening, running and closing balance; filters by date and type; print with the browser. Export to PDF/Excel is not built.
- ✅ Supplier payments: cash, cheque or bank transfer; settled against the oldest bills first; warning and advance when paying more than the balance; cheque register; a bounced cheque puts the balance back. **Missing:** reminders for post-dated cheques.
- ✅ **Quick product editor:** a pencil on each products-list row opens a dialog for the product's code and name and each sub-product's code and name, saved together (`PATCH /api/products/:id/names`, `renameProduct`). A new main code asks first, then renames the sub-product codes unless one was typed by hand. Old bills and the rename history follow every change. The full and quick product saves return cost fields only to cost viewers.
- ✅ Products and sub-products: auto 5-digit codes, old codes kept, box-to-piece buying, mix paint item created for loose-sale paints (several sizes can link to one), code renames that cascade to sub and MP codes after confirmation, price changes for one or all sub-products with price history.
- ✅ Renaming a product (code, name or receipt name), or renaming one sub-product, also updates old bills, quotations and held bills (`sale_lines` code, name and print name). Amounts never change. Each rename is logged as `product.rename`. The Super Admin sees "old → new" under "Name and code changes" on the product page (`GET /api/products/:id/renames`).
- ✅ Purchases (GRN): draft or post; server-side line maths; Rs 1 match against the supplier invoice total; duplicate-invoice warning; automatic sub-product rules 1–7 (match, reuse at zero stock, new code when anything differs); paid now; edit while stock is unmoved (reopen); Admin reversal; keyboard grid; inline new item.
- ✅ **The sales discount is never above the purchase discount**, not even on a draft (`computeLines` in `purchases/service.ts` refuses drafts too; posting and price changes already did). The GRN screen keeps Enter on a cell that breaks a price rule, lists every issue of the line under it and shows the limit ("max 200.00"); the price dialog shows it as well.
- ✅ The GRN supplier and sales rep boxes offer "+ Add supplier" (the supplier form opens with the typed name, and its similar-name warning offers to use that supplier instead) and "+ Add rep" (`POST /api/suppliers/:id/reps`). The item cell's "+ Add item" opens the product form with the typed name, or the code if it is all digits.
- ✅ Stock view with filters (category, brand, supplier, location, low, out, expiring, inactive), product detail, bin card, zero-stock sub-products hidden.
- ✅ Mix paint transfers at weighted-average cost; PIN flow when a cashier opens a can at the counter. Price per liter: the one typed, or the Admin's price for the whole can ÷ liters (`adminCanPrice`), or the current price; the very first can takes its own sales price ÷ liters. Never below the new average cost (`assertMixPrice`, plain-words `BELOW_COST` message).
- ✅ Location transfers (API, plus "Move 1 from Store?" in billing). There is no stand-alone transfer screen yet.
- ✅ Adjustments (API; write-offs need an Admin). There is no adjustment screen yet; only the API and tests.

### Billing
- ✅ Invoices and quotations (F4), wholesale (F6), customer name with suggestions (F3).
- ✅ Multi-price pop-up (inline picker), FIFO split across batches, typing a sub code skips the pop-up.
- ✅ Loose sales (`1.5L` or `0.375`), open a can with a Stock Manager or Admin PIN, price per liter changed with an Admin PIN.
- ✅ Discount rules (at most the purchase discount, never below cost, never above the R-price, wholesale takes the W-price), cash payment with change, the "Print receipt?" prompt, drawer kick.
- ✅ Hold (F7) and recall (F8); bill history (F9) with P reprint, R return, C convert, V void. A held bill is deleted with its bin button or the Delete key in the F8 list, after a confirmation (Enter confirms, Esc keeps it).
- ✅ **Nothing rung up disappears** (closing cheating holes):
  - **Deleting a held bill** (F8: bin button or Delete) needs a typed reason. The bill is kept as status `DELETED` with who, when and why (`sales.deleted_at`, `deleted_by_id`, `delete_reason`), and its lines go into the audit log.
  - **Deleting a quotation** (bill history: D or the button) works only for an issued one that hasn't become an invoice. It keeps its number, so numbers stay gap-free, and can't be converted or reprinted afterwards.
  - **Bill history → Deleted** lists both, with who, when and why. They are never counted as sales.
  - **Every hold is logged** (`sale.hold`). Holding a recalled bill again logs what it had before (`sale.hold_again`), and paying a recalled bill logs the lines it was held with (`sale.complete` → `before.held`).
  - **Lines taken off before payment:** lines removed or quantities lowered, and a bill left unpaid when the screen closes (sent with `sendBeacon`), are logged as `bill.lines_removed` through `POST /api/sales/removed-lines`.
  - **Dashboard "Things to check"** counts, for the range: voids, held bills and quotations deleted, lines taken off bills, returns, reprints, days closed automatically, test mode switches and mix paint prices changed at the counter.
  - **Still open, the owner's call:** day end no longer counts the cash in the drawer (the owner's "Simplify Day End" change), so a cash shortage isn't flagged.
- ✅ **A resting mouse no longer picks a suggestion.** Lists (item suggestions, batch picker, held bills, dropdowns) follow the mouse only when it moves, so a list opening under a still pointer can't change what Enter takes.
- ✅ **Same item, same line:** adding the same batch at the same discount (or the same loose paint at the same price per liter) adds to that line's qty (`mergeLines` in `billing/bill.ts`). A different batch, discount or price stays a separate line. Changing a line's discount to match another line of the same batch merges them. Lines are compared on their own discounts, never on "No discount".
- ✅ **Arrow keys between buttons** (`lib/arrowNav.ts`): in every dialog (Yes/No on "Print receipt?", confirm boxes, PIN prompt…), the billing header and toolbar, and the main menu. ←↑ go to the previous button and →↓ to the next. Text boxes, lists, dropdowns and radio groups keep their own arrow keys.
- ✅ **No discount (Alt+N)**, a toggle next to Wholesale. While it is on, every line sells at the R-price with no discount, lines added later included, and item entry skips the discount box. Turning it off gives each line its own discount back. It is sent as a 0% discount per line, so the server prices it the same way. It can't be used on wholesale bills, which already have no extra discount.
- ✅ Receipts: 80 mm ESC/POS with "You saved Rs X", reprint stamps, return notes, the day-end report. Drivers: network 9100, shared Windows printer, file (testing), none.
- 🟡 Sinhala receipts: the setting exists but receipts always print in English. Printing Sinhala as a raster image is not built.
- ✅ Returns: refund = what was paid; restock to the same batch, or to the Damaged location; loose paint blocked; old-system bills need an Admin.
- ✅ Day end: opening float, cash in/out with reasons, expected cash, then a backup. Printing is optional: "Finish day" or "Finish & print report", and any recent day end can be printed later from its row (`POST /api/shifts/:id/print`).
- ✅ **A day left open closes by itself** when its counter next opens on a later date (`autoCloseShift`, logged as `shift.auto_close`, counted on the dashboard). A forgotten day end no longer blocks the next day's billing.

### HRM and commission (added by the owner on `main`)
- ✅ Monthly commission share, fixed expenses and salaries (`modules/hrm`, `hrm/HrmPage.tsx`).
- ✅ **Month start day.** The Super Admin picks the day sales months start (1–28; setting `closing.monthStartDay`, also on the Settings page). A month is named after the month it starts in: with day 25, "October" runs 25 Oct – 24 Nov. The helpers are `monthPeriod` and `periodContaining` in `shared/domain/periods.ts`. **Any future monthly report or closing must use them**, so every screen agrees on what "this month" is.

### Dashboard (Admin)
- ✅ Charts over one date range (Today, 7, 30 or 90 days, This month, which follows the month start day, or 12 months), each compared with the period before (`GET /api/dashboard`, `modules/dashboard/service.ts`; the ranges are `dashboardRanges` in `shared/domain/periods.ts`):
  - headline tiles with a trend line and the change against the period before;
  - **one sales chart** that switches between By hour, day, week (Monday to Sunday), month (business months, 12-month range only) or weekday (`groupSales`);
  - gross profit and returns by day;
  - best-selling products and sales by category;
  - stock health, supplier dues, cashiers, counters, alerts and system.
- Charts are small hand-drawn SVGs in `components/charts/charts.tsx`: no chart library, theme colours only, hover and keyboard tooltips, and a table view for every chart.
- Profit is Super Admin only (`cost.totals`), and supplier dues need `suppliers.view`.
- Only paid invoices count: quotations, held and voided bills don't.

### Look and feel
- ✅ Custom rounded controls instead of the browser's:
  - a dropdown (`components/ui/select.tsx`). It takes the same props as a native select, works from the keyboard and inside dialogs, and Esc closes only the list.
  - styled checkboxes, with a dash for "some ticked";
  - number inputs without spinners;
  - rounded, theme-coloured scrollbars (pill thumb that darkens on hover; Firefox gets a thin bar in the same colours).
- ✅ **Colour themes** (Settings → Colour theme, Super Admin only):
  - five ready-made themes: Teal (the original), Ocean blue, Royal purple, Berry and Graphite;
  - a custom colour (picker or colour code);
  - light, dark, or "Same as the PC".
  The choice is stored in the `appearance` setting and applies to every screen and counter, including the login screen (`/api/setup/status` is public and carries it). Each PC remembers the last theme so it doesn't flash the old colours at start. `shared/domain/themes.ts` works out all colours from one accent and keeps text readable (tests check 4.5:1 contrast). Green, amber and red never change. Screens must use the colour tokens (`bg-accent`, `text-muted`…), never Tailwind palette colours, or they won't follow the theme.
- ✅ The permission editor's sections (Billing, Stock, HRM, Admin, Cost privacy) open and close one by one, with Open all / Close all, a count, a change count and a tick-all box. The View/Add/Edit/Approve/Export toggles have icons.
- ✅ Page actions have icons beside their words (`Button icon={…}`). Print, Edit and Delete in page headers and the Previous/Next page buttons are icon buttons with tooltips.
- ✅ Row actions are icon buttons (`components/ui/icon-button.tsx`) with a tooltip on hover and keyboard focus, and the words as `aria-label`.
- ✅ The app's own confirm and one-line question dialogs (`components/AskDialog.tsx`, `useConfirm()` and `useAsk()`, which can start with `initial` text) replace `window.confirm` and `window.prompt`.
- ✅ **Pickers** (`components/ui/combobox.tsx`) for the GRN supplier, sales rep and item cells, the mix paint search, and every value list (unit, category, brand via `ValueSelect`):
  - typing suggests (server search, or a filtered fixed list); arrow keys, Enter and Esc work; an Enter typed before the answer arrives waits for it;
  - leaving the box without picking clears what was typed, so a box never shows a name it isn't using;
  - a name that isn't there offers "+ Add …" in the list, and a + button sits beside the box; both open a small pop-up that starts with the typed name (`AddValueDialog` for value lists);
  - after a pick the name is selected, so typing again starts afresh.
  Use it for any new "type to find" box instead of a hand-made suggestion list.

### Owner's changes the tests now follow
These came in with the owner's own work on `main`; the tests were updated to match them:
- A loose-sale paint's mix item is named "… (Mix Paint)", so loose bill lines read "White Emulsion (Mix Paint), loose". Mix items also show in billing suggestions and can be sold by their MP code.
- The day starts by itself (zero float) on a counter's first bill; after that day's day end the counter takes no more bills that day.
- A PC that logs in without a counter code works as the first active counter, so "Log in at a counter" only happens when no counter exists.
- Staff land on the Main menu (`/menu`); "Open Billing Screen" opens billing. The billing footer reads "Today: Rs … · N bills".
- Sales discounts can be percentages; the billing discount box shows the batch default as a percent (the seed uses 5%, so the e2e mock-up bill totals Rs 6,365.00).
- One fix in code rather than tests: the mix paint transfer had lost its "never below the average cost" check (the database still refused, with an unclear message). It was put back.

## Decisions taken where the plan was silent or ambiguous

These were my calls; confirm them with the owner if any matters:

1. **Number format tokens** use braces (`INV-{NNNNNN}`, `GRN-{YYYY}-{NNNNN}`, `DE-{YYYY}{MM}{DD}-{COUNTER}`, plus `{YY}` and `{LOC}`). Without braces, the N in "INV" would be read as a digit. A format with a date counts per date scope (GRN restarts every year).
2. **The invoice number is taken at payment, not when the bill starts.** The top bar shows a preview of the next number. Held bills have no number, so numbers stay gap-free.
3. **A mix paint price changed at the counter applies to that line only** (Admin PIN, logged on the line). The stored price per liter changes only through a mix-paint transfer.
4. **Converting a quotation keeps the quoted net price until the validity date**, even above the counter discount cap. A lower current price wins, and it never sells below cost; if it would, the cashier is told to quote again. Batches are re-picked oldest first.
5. **Admins don't create GRNs**, because the GRN screen shows cost and Admins must not see cost. They can view purchases (cost fields hidden) and reverse them. A person who does both gets both roles ticked.
6. **Any negative adjustment counts as a write-off and needs an Admin**, MP wastage included.
7. **One day end per counter per date.** The day opens by itself on the first bill and, if nobody did the day end, closes by itself when the counter is next used on a later date (no cash count; the dashboard shows it).
8. **Cash rounding** setting: none by default; Rs 1, 5 or 10 are possible, stored as a rounding adjustment on the bill.
9. **Reprints** are numbered from #2; the original print is copy #1.
10. **PINs are stored as HMAC-SHA256** with the server's `PIN_SECRET`, so a PIN alone can identify the user (they are unique). Losing `PIN_SECRET` means resetting every PIN.
11. **Reusing a sub-product** updates its actual price to the weighted average of stock on hand. Free items can change the actual price even when the cost matches.
12. **Customers** have no table. Names and phones are stored on the bill, and suggestions come from earlier bills.
13. **The billing lookup sends `maxDiscount`** (purchase discount, capped so the price stays at or above cost) instead of cost, so the screen can enforce limits without revealing cost.
14. **Boxed items:** Value, Qty, Free and the purchase discount are per box. R-price, W-price, the sales discount and the sales price are per piece.
15. **Old bills follow product renames** (the owner asked for this). It overrides the plan's "old bills never change" for names and codes only: prices, quantities and totals stay as sold. A bill line keeps its text if someone had changed it separately; only lines still showing the old text are updated.
16. **Permission changes for one user** are stored as differences from their roles: "add X" or "take away Y". If the roles change later, the differences still apply. A Super Admin always has everything, and Super Admin-only permissions can never be given to anyone else.
17. **Customised built-in roles** keep their name. The Super Admin role can't be edited.
18. **Test mode is per user and works on a full copy** (the owner asked for single accounts, switched by the Super Admin who is usually away), rather than flags on rows, so nothing in test mode can leak into real figures. Against misuse: only the Super Admin switches it, the user's screens show it, every slip says TEST, the drawer stays shut, and each switch with the test bill count is kept in the real audit log. It has no time limit (the owner's call), so a user left in test mode keeps their sales out of the real data until someone notices the red frame.

## Known gaps and rough edges

- The cloud side (`APP_MODE=cloud`, the mirror DB, the sync agent, the online admin panel) is not built. `shopOnly()` already blocks writes in cloud mode.
- No reports, PDF or Excel exports yet (the dashboard has charts, see Admin below).
- No screens yet for monthly closing, commission, reorder, purchase returns, stock count, location transfers or adjustments. The shared formulas exist for closing and reorder, and the database tables exist for all of them.
- Alerts: only backup failures create alerts. Low stock shows on the dashboard straight from the stock query. Near expiry, cheques due, day end not done and high returns are not generated.
- The clock guard compares the PC with the shop server, not with the cloud.
- Native date inputs follow the browser language (they may show MM/DD/YYYY). Everything else shows DD/MM/YYYY.
- The web bundle is about 740 kB in one chunk (fine on a LAN; it could be split).
- ESLint is not set up; Prettier and `tsc` are the checks.
- `e2e/start-server.sh` lost its executable bit in a commit made on Windows. It was restored in this session with `git update-index --chmod=+x`.
- No desktop shell yet (Tauri or Electron full-screen wrapper that starts with Windows and blocks browser keys).
- Test mode needs the database role to have CREATEDB (the message says so if it is missing); it doesn't need `pg_dump`. Backups do: `core/pgtools.ts` finds `pg_dump` in `PG_BIN_DIR`, then PATH, then PostgreSQL's usual install folders (`C:\Program Files\PostgreSQL\<version>\bin` on Windows, which the installer doesn't add to PATH), and says which folder to set when it is missing. The copy (`<db>_testmode`) stays on disk until it is refreshed. When the cloud sync agent is built, it must read only the real database (`testMode.production`), never the copy. A new in-memory cache of database rows must be kept per scope (see `SettingsService`) or reset in `TestModeService`'s `onChange`.

## Suggested next steps (in order)

1. **Small Phase 1 screens:** location transfers, adjustments (with the write-off PIN) and the backups/restore page. The APIs exist; restore needs `pg_restore` plus a Super Admin confirmation.
2. **Data import:** Excel templates (ExcelJS) for suppliers, products (keeping old codes) and opening stock with cost and prices. Opening stock should post `OPENING` stock movements through `moveStock`.
3. **Shop install:** an Inno Setup script that bundles Node 22, PostgreSQL 16, the built server (`pnpm --filter @aruna/server build`) and `apps/web/dist`; Windows services; first-run wizard; generate `PIN_SECRET` at install.
4. **Automatic updates** as the plan describes (release feed with signatures, back up first, `prisma migrate deploy`, health check, roll back).
5. **Sinhala receipts:** render the receipt to a 576 px bitmap (for example with `@napi-rs/canvas` and Noto Sans Sinhala) and send it as an ESC/POS raster (`GS v 0`).
6. **Phase 2:** reports with three date modes and PDF/Excel export, dashboard charts, commission (the rate already lives on `users.commission_rate`), monthly closing (formula in `shared/domain/closing.ts`, tables `cutoff_rules` and `monthly_closings`), reorder lists with PDFs per supplier, purchase returns (tables exist), stock count, alert generation, then the cloud sync agent and the view-only panel.

## How the API is organised

All routes are under `/api`. Each module has `routes.ts` (HTTP, permission guards, transactions) and `service.ts` (rules) under `apps/server/src/modules/<name>/`:

- **Auth and setup:** `setup/` (first run), `auth/routes.ts` (login, logout, me, PIN switch/unlock, lock, change password, recover, shortcuts, verify-approval).
- **Admin:** `users/` (users, roles, sessions), `admin/` (settings, number formats, counters, audit log), `values/` (value manager), `system/` (status bar, alerts, backups, test mode, the `/api/live` WebSocket).
- **Stock:** `suppliers/` (suppliers, ledger, payments, cheques), `products/` (products, search, sub-products, prices, bin card), `purchases/` (GRN), `mixpaint/`, `stock/` (transfers, adjustments, stock per location).
- **Billing:** `sales/` (lookup, status, sales, hold, history, void, reprint, convert, returns, receipt printing), `shifts/` (day end).

The integration tests in `apps/server/test/*.test.ts` double as executable examples of every flow (see `fixtures.ts` for building a catalog and posting GRNs).
