# Aruna POS

A keyboard-first point of sale for **Pannala Aruna Paint Center**. It runs on a shop server PC; billing counters and the stock/admin PC use it over the shop network, so billing never waits for the internet.

- **Billing:** invoices and quotations, batches at different prices (oldest first), loose paint by the liter, cash only, 80 mm receipts, hold/recall, returns, voids, day end.
- **Stock:** suppliers and payments, purchases (GRN) that create sub-products automatically, mix paint, stock view and bin cards.
- **Admin:** users with combinable roles, value lists, settings, number formats, audit log.

The full requirements are in [`docs/POS_System_Plan.pdf`](docs/POS_System_Plan.pdf). Build status, decisions and next steps are in [`docs/PROGRESS.md`](docs/PROGRESS.md).

## Run it locally

Needs Node 22, pnpm 10 and PostgreSQL 16.

```bash
pnpm install
createuser -d aruna -P            # password: aruna (or change DATABASE_URL)
createdb -O aruna aruna_pos
cp apps/server/.env.example apps/server/.env
pnpm --filter @aruna/server db:deploy
pnpm db:seed
pnpm dev
```

Open http://localhost:5173/?counter=C1 and log in as `cashier` / `password123` (PIN 4444). Other demo users: `owner` (Super Admin), `admin` and `stock`; all use the same password.

## Checks

```bash
pnpm typecheck
pnpm test                    # unit + integration tests (uses a throwaway aruna_test database)
pnpm --filter @aruna/web build && (cd apps/web && npx playwright test)   # keyboard end-to-end tests
```
