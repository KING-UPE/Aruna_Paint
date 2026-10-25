# Build progress and handoff

Last updated: 25 Oct 2026, end of the first build session (branch `claude/affectionate-hopper-q0hr5p`).
This file is for whoever continues the work: a person or a new Claude session. The spec is `docs/POS_System_Plan.pdf`; section names below match the plan's headings.

## State in one paragraph

Phase 1 ("go-live core") is mostly built and tested end to end. The shared rules, data model, server API, and screens for Billing, Stock and Admin all work against a real PostgreSQL database. What Phase 1 still lacks is the shop-install work: the Windows installer, automatic updates, data import from the old system, Sinhala receipts, and the restore wizard. Phase 2 (reports, closing, reorder, cloud) and Phase 3 have not started, but the database tables for most of them already exist.

Test status when this was written: 62 shared unit tests, 78 server integration tests and 2 Playwright keyboard e2e tests, all passing. `pnpm typecheck` is clean.

## Phase 1 checklist (plan § "Build phases and go-live")

Legend: ✅ done and tested · 🟡 partly done · ⬜ not started

### Foundation
- ✅ Login with username + password; PIN user switching; idle screen lock (client timer + server enforcement); forced password change after reset; 8 printed recovery codes for the Super Admin.
- ✅ Roles by checkbox (combined per user), custom roles built from module permissions, safety rules (an active Super Admin always remains; Super Admin-only permissions can't go into a custom role), and server-side permission checks on every route.
- ✅ Manager override by PIN, with both names in the audit log (void, mix price change, open can, write-off, old-system return, reverse purchase).
- ✅ Per-user shortcut keys: remap in My profile, validation against reserved and already-used keys, reset to default, F1 help, Ctrl+K command palette.
- ✅ Value manager: categories, brands, units (with an allows-decimal flag), locations (Super Admin only), reasons (with "applies to"), cutoff types. Unique names ignoring case and spaces, merge with history, deactivate when in use, ordering, "+ Add" inside dropdowns.
- ✅ Audit log: written in the same transaction as each change; append-only at the database level; viewer with filters and before/after values.
- ✅ Sync outbox written from day one by DB triggers in the same transaction. The sync agent that pushes it to the cloud does not exist yet (Phase 2).
- 🟡 Backups: `pg_dump` at day end and nightly (`backup.nightlyAt`), keeping 30 daily and 12 monthly copies, optional second folder, failure alerts, manual backup API, backup list. **Missing:** a cloud copy, the restore wizard, the monthly test-restore reminder, and a UI to start a backup.
- ⬜ Windows installer (Inno Setup/NSIS; Node and PostgreSQL as services) and first-run wizard polish. The first-run wizard itself exists (`/api/setup` and `SetupPage`).
- ⬜ Automatic updates (signed release feed, download, backup first, migrate, health check, roll back).
- ⬜ Data import: Excel templates for suppliers, products and opening stock; a go-live stock count.
- ✅ Settings (shop, receipt, billing, closing, alerts, backup, cloud), number formats (letters allowed), counters with printer settings.

### Stock
- ✅ Suppliers: auto SUP- codes, 1–3 phones in one format, reps, similar-name warning, credit days, opening balance (locked once entries exist), deactivate.
- ✅ Supplier activity log: opening, running and closing balance; filters by date and type; print with the browser. Export to PDF/Excel is not built.
- ✅ Supplier payments: cash, cheque or bank transfer; settled against the oldest bills first; warning and advance when paying more than the balance; cheque register; a bounced cheque puts the balance back. **Missing:** reminders for post-dated cheques.
- ✅ Products and sub-products: auto 5-digit codes, old codes kept, box-to-piece buying, mix paint item created for loose-sale paints (several sizes can link to one), code renames that cascade to sub and MP codes after confirmation, price changes for one or all sub-products with price history.
- ✅ Purchases (GRN): draft or post; server-side line maths; Rs 1 match against the supplier invoice total; duplicate-invoice warning; automatic sub-product rules 1–7 (match, reuse at zero stock, new code when anything differs); paid now; edit while stock is unmoved (reopen); Admin reversal; keyboard grid; inline new item.
- ✅ Stock view with filters (category, brand, supplier, location, low, out, expiring, inactive), product detail, bin card, zero-stock sub-products hidden.
- ✅ Mix paint transfers at weighted-average cost; price kept or changed (never below the average); PIN flow when a cashier opens a can at the counter.
- ✅ Location transfers (API, plus "Move 1 from Store?" in billing). There is no stand-alone transfer screen yet.
- ✅ Adjustments (API; write-offs need an Admin). There is no adjustment screen yet; only the API and tests.

### Billing
- ✅ Invoices and quotations (F4), wholesale (F6), customer name with suggestions (F3).
- ✅ Multi-price pop-up (inline picker), FIFO split across batches, typing a sub code skips the pop-up.
- ✅ Loose sales (`1.5L` or `0.375`), open a can with a Stock Manager or Admin PIN, price per liter changed with an Admin PIN.
- ✅ Discount rules (at most the purchase discount, never below cost, never above the R-price, wholesale takes the W-price), cash payment with change, the "Print receipt?" prompt, drawer kick.
- ✅ Hold (F7) and recall (F8); bill history (F9) with P reprint, R return, C convert, V void.
- ✅ Receipts: 80 mm ESC/POS with "You saved Rs X", reprint stamps, return notes, the day-end report. Drivers: network 9100, shared Windows printer, file (testing), none.
- 🟡 Sinhala receipts: the setting exists but receipts always print in English. Printing Sinhala as a raster image is not built.
- ✅ Returns: refund = what was paid; restock to the same batch, or to the Damaged location; loose paint blocked; old-system bills need an Admin.
- ✅ Day end: opening float, cash in/out with reasons, counted denominations, expected-cash difference, printed report, then a backup.

## Decisions taken where the plan was silent or ambiguous

These were my calls; confirm them with the owner if any matters:

1. **Number format tokens** use braces (`INV-{NNNNNN}`, `GRN-{YYYY}-{NNNNN}`, `DE-{YYYY}{MM}{DD}-{COUNTER}`, plus `{YY}` and `{LOC}`). Without braces, the N in "INV" would be read as a digit. A format with a date counts per date scope (GRN restarts every year).
2. **The invoice number is taken at payment, not when the bill starts.** The top bar shows a preview of the next number. Held bills have no number, so numbers stay gap-free.
3. **A mix paint price changed at the counter applies to that line only** (Admin PIN, logged on the line). The stored price per liter changes only through a mix-paint transfer.
4. **Converting a quotation keeps the quoted net price until the validity date**, even above the counter discount cap. A lower current price wins, and it never sells below cost; if it would, the cashier is told to quote again. Batches are re-picked oldest first.
5. **Admins don't create GRNs**, because the GRN screen shows cost and Admins must not see cost. They can view purchases (cost fields hidden) and reverse them. A person who does both gets both roles ticked.
6. **Any negative adjustment counts as a write-off and needs an Admin**, MP wastage included.
7. **One day end per counter per date.** Invoices need an open day (float entered). Quotations don't. Yesterday's open day must be closed before billing today.
8. **Cash rounding** setting: none by default; Rs 1, 5 or 10 are possible, stored as a rounding adjustment on the bill.
9. **Reprints** are numbered from #2; the original print is copy #1.
10. **PINs are stored as HMAC-SHA256** with the server's `PIN_SECRET`, so a PIN alone can identify the user (they are unique). Losing `PIN_SECRET` means resetting every PIN.
11. **Reusing a sub-product** updates its actual price to the weighted average of stock on hand. Free items can change the actual price even when the cost matches.
12. **Customers** have no table. Names and phones are stored on the bill, and suggestions come from earlier bills.
13. **The billing lookup sends `maxDiscount`** (purchase discount, capped so the price stays at or above cost) instead of cost, so the screen can enforce limits without revealing cost.
14. **Boxed items:** Value, Qty, Free and the purchase discount are per box. R-price, W-price, the sales discount and the sales price are per piece.

## Known gaps and rough edges

- The cloud side (`APP_MODE=cloud`, the mirror DB, the sync agent, the online admin panel) is not built. `shopOnly()` already blocks writes in cloud mode.
- No reports, charts, PDF or Excel exports yet. The dashboard shows today's cards only.
- No screens yet for monthly closing, commission, reorder, purchase returns, stock count, location transfers or adjustments. The shared formulas exist for closing and reorder, and the database tables exist for all of them.
- Alerts: only backup failures create alerts. Low stock shows on the dashboard straight from the stock query. Near expiry, cheques due, day end not done and high returns are not generated.
- The clock guard compares the PC with the shop server, not with the cloud.
- Native date inputs follow the browser language (they may show MM/DD/YYYY). Everything else shows DD/MM/YYYY.
- The web bundle is about 740 kB in one chunk (fine on a LAN; it could be split).
- ESLint is not set up; Prettier and `tsc` are the checks.
- No desktop shell yet (Tauri or Electron full-screen wrapper that starts with Windows and blocks browser keys).

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
- **Admin:** `users/` (users, roles, sessions), `admin/` (settings, number formats, counters, audit log), `values/` (value manager), `system/` (status bar, alerts, backups, the `/api/live` WebSocket).
- **Stock:** `suppliers/` (suppliers, ledger, payments, cheques), `products/` (products, search, sub-products, prices, bin card), `purchases/` (GRN), `mixpaint/`, `stock/` (transfers, adjustments, stock per location).
- **Billing:** `sales/` (lookup, status, sales, hold, history, void, reprint, convert, returns, receipt printing), `shifts/` (day end).

The integration tests in `apps/server/test/*.test.ts` double as executable examples of every flow (see `fixtures.ts` for building a catalog and posting GRNs).
