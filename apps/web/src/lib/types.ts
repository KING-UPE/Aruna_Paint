import type { AppearanceSettings } from '@aruna/shared';
/** Shapes the shop server returns. Money and quantities are strings ("1250.00", "1.500"). */

export interface Me {
  user: { id: string; username: string; fullName: string; mustChangePassword: boolean };
  roles: string[];
  permissions: string[];
  counter: { id: string; code: string; name: string; locationId: string } | null;
  location: { id: string; code: string; name: string } | null;
  locked: boolean;
  shortcuts: { screen: string; action: string; keys: string }[];
  settings: {
    shopName: string;
    idleLockMinutes: number;
    timeFormat: '12h' | '24h';
    quotationValidityDays: number;
  };
  appearance: AppearanceSettings;
  mode: 'shop' | 'cloud';
  /** This user works on the test copy (set by the Super Admin). */
  testMode: boolean;
}

export interface ValueItem {
  id: string;
  name: string;
  active: boolean;
  sortOrder: number;
  allowsDecimal?: boolean;
  appliesTo?: string[];
  code?: string;
  kind?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalAmount?: string;
}

export interface Batch {
  id: string;
  code: string;
  available: string;
  firstReceivedAt: string;
  expiryDate: string | null;
  rPrice: string;
  wPrice: string;
  salesPrice: string;
  salesDiscount: string;
  maxDiscount: string;
}

export interface BillingItem {
  productId: string;
  code: string;
  name: string;
  printName: string;
  unit: { name: string; allowsDecimal: boolean };
  packSize: string | null;
  allowLooseSale: boolean;
  matchedSubProductId: string | null;
  stockHere: string;
  stockElsewhere: string;
  elsewhere: {
    subProductId: string;
    code: string;
    locationId: string;
    location: string;
    qty: string;
  }[];
  batches: Batch[];
  mix: {
    productId: string;
    subProductId: string;
    code: string;
    name: string;
    litersHere: string;
    pricePerLiter: string;
    wPricePerLiter: string;
  } | null;
}

export interface BillingStatus {
  counter: { id: string; code: string; name: string } | null;
  today: { total: string; bills: number };
  shift: { id: string; no: string; businessDate: string; needDayEnd: boolean } | null;
  nextNumbers: { INVOICE: string; QUOTATION: string };
  sync: { linked: boolean; pending: number; lastSyncedAt: string | null };
  serverTime: string;
}

export interface SaleListItem {
  id: string;
  /** Null for a held bill (it never got a number). */
  no: string | null;
  kind: 'INVOICE' | 'QUOTATION';
  status: 'HELD' | 'COMPLETED' | 'VOID' | 'DELETED';
  /** A held bill or quotation taken away: kept, with who, when and why. */
  deleted: { at: string; by: string; reason: string } | null;
  createdAt: string;
  completedAt: string | null;
  cashier: string;
  counter: string;
  wholesale: boolean;
  customerName: string;
  itemCount: number;
  netTotal: string;
  refundedTotal: string;
  validUntil: string | null;
  convertedTo: string | null;
  convertedFrom: string | null;
  printCount: number;
}

export interface SaleDetail {
  id: string;
  /** Null for a held bill (it never got a number). */
  no: string | null;
  kind: 'INVOICE' | 'QUOTATION';
  status: 'HELD' | 'COMPLETED' | 'VOID' | 'DELETED';
  /** A held bill or quotation taken away: kept, with who, when and why. */
  deleted: { at: string; by: string; reason: string } | null;
  createdAt: string;
  wholesale: boolean;
  customerName: string;
  validUntil: string | null;
  completedAt: string | null;
  cashier: string;
  counter: string;
  itemCount: number;
  totalQty: string;
  gross: string;
  discount: string;
  netTotal: string;
  cashGiven: string | null;
  change: string | null;
  refundedTotal: string;
  void: { at: string; by: string; approver: string; reason: string; note: string } | null;
  convertedTo: { id: string; no: string } | null;
  lines: {
    id: string;
    lineNo: number;
    code: string;
    name: string;
    unitName: string;
    isLoose: boolean;
    qty: string;
    unitPrice: string;
    discountPerUnit: string;
    amount: string;
    returnedQty: string;
    returnableQty: string;
    refundedAmount: string;
  }[];
  returns: { id: string; no: string; at: string; by: string; refundTotal: string }[];
  reprints: { copyNo: number; at: string; by: string }[];
}

export interface ShiftSummary {
  id: string;
  no: string;
  status: 'OPEN' | 'CLOSED';
  counter: { id: string; code: string; name: string };
  businessDate: string;
  openedBy: string;
  openedAt: string;
  closedBy: string | null;
  openingFloat: string;
  billCount: number;
  voidCount: number;
  returnCount: number;
  cashSales: string;
  cashRefunds: string;
  cashIn: string;
  cashOut: string;
  expectedCash: string;
  countedCash: string | null;
  difference: string | null;
  denominations: Record<string, number>;
  movements: {
    id: string;
    at: string;
    kind: 'IN' | 'OUT';
    amount: string;
    reason: string;
    note: string;
    by: string;
  }[];
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  phones: string[];
  address: string;
  description: string;
  email: string;
  creditDays: number;
  openingBalance: string;
  active: boolean;
  balance: string;
  reps: { id: string; name: string; phone: string; active: boolean }[];
}

export interface ProductSummary {
  id: string;
  code: string;
  name: string;
  printName: string;
  description: string;
  type: 'STANDARD' | 'MIX';
  category: { id: string; name: string } | null;
  brand: { id: string; name: string } | null;
  unit: { id: string; name: string; allowsDecimal: boolean };
  buyingUnit: { id: string; name: string } | null;
  packSize: string | null;
  piecesPerBox: number;
  reorderLevel: string;
  reorderQty: string;
  allowLooseSale: boolean;
  mixProduct: { id: string; code: string; name: string } | null;
  trackExpiry: boolean;
  active: boolean;
}

export interface StockListItem extends ProductSummary {
  stock: string;
  subProductsInStock: number;
  lowStock: boolean;
  outOfStock: boolean;
}

export interface SubProduct {
  id: string;
  code: string;
  seq: number;
  name: string;
  supplier: { id: string; code: string; name: string } | null;
  rPrice: string;
  wPrice: string;
  salesDiscount: string;
  salesPrice: string;
  maxDiscount: string;
  expiryDate: string | null;
  firstReceivedAt: string | null;
  active: boolean;
  totalStock: string;
  hidden: boolean;
  stock: { locationId: string; location: string; qty: string }[];
  marketValue?: string;
  purchaseDiscount?: string;
  costPrice?: string;
  actualPrice?: string;
  margin?: string;
}

export interface ProductDetail {
  product: ProductSummary;
  subProducts: SubProduct[];
  feeders: { id: string; code: string; name: string; packSize: string | null }[];
}

export interface StockSearchItem extends ProductSummary {
  matchedSubProductId: string | null;
  stockHere: string;
  stockTotal: string;
  lastPurchase: {
    value: string;
    discount: { type: 'PERCENT' | 'AMOUNT'; value: string };
    rPrice: string;
    wPrice: string;
    salesDiscount: { type: 'PERCENT' | 'AMOUNT'; value: string };
  } | null;
}
