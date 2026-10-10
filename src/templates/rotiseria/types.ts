export interface CreateProductData {
  businessId: string;
  name: string;
  priceUnit: number;
  priceDozen?: number;
  category?: string;
}

export interface UpdateProductData {
  name?: string;
  priceUnit?: number;
  priceDozen?: number | null;
  category?: string;
}

export interface CreatePromoData {
  businessId: string;
  name: string;
  description?: string;
  price: number;
}

export interface UpdatePromoData {
  name?: string;
  description?: string;
  price?: number;
}

export interface SaleLineInput {
  name: string;
  quantity: number;
}

export interface ResolvedSaleLine {
  productId?: string | null;
  promoId?: string | null;
  name: string;
  category: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

export interface PricingResult {
  lines: ResolvedSaleLine[];
  total: number;
  breakdown: string[];
}

export interface DraftSaleData {
  items: SaleLineInput[];
  nota?: string;
  customShiftDate?: string; // YYYY-MM-DD
  _modifying?: boolean;
  _awaitingCustomDate?: boolean;
}

export interface DaySummary {
  shiftDate: Date;
  shiftDateStr: string;
  salesTotal: number;
  salesCount: number;
  cancelledTotal: number;
  cancelledCount: number;
  topProducts: Array<{ name: string; quantity: number; subtotal: number }>;
}

export interface CategorySummary {
  category: string;
  quantity: number;
  subtotal: number;
}

export interface StatsSummary {
  periodLabel: string;
  periodKey: string;
  salesTotal: number;
  salesCount: number;
  averageTicket: number;
  cancelledCount: number;
  top3Products: Array<{ name: string; quantity: number; subtotal: number }>;
  categories: CategorySummary[];
  productsByCategory: Record<string, Array<{ name: string; quantity: number; subtotal: number }>>;
}
