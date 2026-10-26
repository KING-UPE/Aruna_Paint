import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('--- Checking current counts before cleanup ---');
  const userCount = await prisma.user.count();
  const roleCount = await prisma.role.count();
  const locationCount = await prisma.location.count();
  const counterCount = await prisma.counter.count();
  const settingCount = await prisma.setting.count();
  const unitCount = await prisma.unit.count();
  const categoryCount = await prisma.category.count();
  const brandCount = await prisma.brand.count();

  console.log({
    users: userCount,
    roles: roleCount,
    locations: locationCount,
    counters: counterCount,
    settings: settingCount,
    units: unitCount,
    categories: categoryCount,
    brands: brandCount,
  });

  const productCount = await prisma.product.count();
  const supplierCount = await prisma.supplier.count();
  const purchaseCount = await prisma.purchase.count();
  const saleCount = await prisma.sale.count();
  console.log({
    products: productCount,
    suppliers: supplierCount,
    purchases: purchaseCount,
    sales: saleCount,
  });

  console.log('--- Cleaning dummy and transactional data ---');

  // List of tables to truncate (order does not matter with CASCADE)
  const tablesToTruncate = [
    // Sales and billing
    'sale_return_lines',
    'sale_returns',
    'sale_lines',
    'sales',
    'reprints',
    'shifts',
    'cash_movements',
    'monthly_closing_lines',
    'monthly_closings',
    // Stock counts and adjustments
    'stock_count_lines',
    'stock_counts',
    'adjustment_lines',
    'adjustments',
    // Transfers and mix paint
    'mp_transfers',
    'transfer_lines',
    'transfers',
    // Purchases and reorders
    'reorder_lines',
    'reorder_lists',
    'purchase_return_lines',
    'purchase_returns',
    'purchase_lines',
    'purchases',
    // Stock and pricing
    'stock_movements',
    'stock_balances',
    'price_history',
    'sub_products',
    'products',
    // Suppliers and payments
    'supplier_ledger',
    'payment_allocations',
    'cheques',
    'supplier_payments',
    'supplier_reps',
    'suppliers',
    // Operational logs / outbox
    'audit_logs',
    'sync_outbox',
    'sync_state',
    'backups',
    'alerts',
    'update_log',
  ];

  for (const table of tablesToTruncate) {
    try {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE;`);
      console.log(`Truncated: ${table}`);
    } catch (err: any) {
      console.warn(`Could not truncate ${table}: ${err.message}`);
    }
  }

  // Reset number sequences
  try {
    await prisma.$executeRawUnsafe(`UPDATE number_sequences SET last_value = 0;`);
    console.log('Reset number_sequences to last_value = 0');
  } catch (err: any) {
    console.warn(`Could not reset number_sequences: ${err.message}`);
  }

  console.log('--- Counts after cleanup ---');
  console.log({
    users: await prisma.user.count(),
    roles: await prisma.role.count(),
    products: await prisma.product.count(),
    suppliers: await prisma.supplier.count(),
    purchases: await prisma.purchase.count(),
    sales: await prisma.sale.count(),
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
