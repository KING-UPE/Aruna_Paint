import { Navigate, Route, Routes } from 'react-router';
import { MixPaintPage } from './MixPaintPage';
import { ProductDetailPage } from './ProductDetailPage';
import { ProductsPage } from './ProductsPage';
import { PurchaseEntryPage } from './PurchaseEntryPage';
import { PurchasesPage } from './PurchasesPage';
import { SupplierLedgerPage } from './SupplierLedgerPage';
import { SuppliersPage } from './SuppliersPage';

export function StockRoutes() {
  return (
    <Routes>
      <Route path="products" element={<ProductsPage />} />
      <Route path="products/:id" element={<ProductDetailPage />} />
      <Route path="suppliers" element={<SuppliersPage />} />
      <Route path="suppliers/:id" element={<SupplierLedgerPage />} />
      <Route path="purchases" element={<PurchasesPage />} />
      <Route path="purchases/new" element={<PurchaseEntryPage />} />
      <Route path="purchases/:id" element={<PurchaseEntryPage />} />
      <Route path="mix-paint" element={<MixPaintPage />} />
      <Route path="*" element={<Navigate to="products" replace />} />
    </Routes>
  );
}
