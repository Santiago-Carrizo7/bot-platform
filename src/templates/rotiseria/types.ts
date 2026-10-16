export interface CreateProductData {
  businessId: string;
  name: string;
  priceUnit: number;
  priceDozen?: number;
  priceHalfDozen?: number | null;
  category?: string;
}

export interface CreateCatalogProductData {
  name: string;
  category?: string;
  priceUnit: number;
  priceDozen?: number | null;
  priceHalfDozen?: number | null;
  isActive?: boolean;
}

export interface UpdateProductData {
  name?: string;
  priceUnit?: number;
  priceDozen?: number | null;
  priceHalfDozen?: number | null;
  category?: string;
}

export interface ProductItem {
  id: string;
  businessId: string;
  name: string;
  priceUnit: number;
  priceDozen?: number | null;
  priceHalfDozen?: number | null;
  category: string;
  isActive: boolean;
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
  isActive?: boolean;
}

export interface NoReconocidoItem {
  texto: string;
  cantidad?: number;
  sugerencia?: string | null;
}

export interface SaleLineInput {
  name: string;
  quantity: number;
  unitPrice?: number;
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

export interface CreateDeliveryZoneData {
  businessId: string;
  name: string;
  price: number;
  barrios?: string[];
}

export interface UpdateDeliveryZoneData {
  name?: string;
  price?: number;
  barrios?: string[];
  isActive?: boolean;
}

export interface DeliveryZoneItem {
  id: string;
  name: string;
  price: number;
  barrios: string[];
  isActive: boolean;
}

export interface DeliveryZoneMatchResult {
  zone: DeliveryZoneItem;
  matchedBy: 'name' | 'barrio';
  matchedTerm: string;
}

export interface PricingResult {
  lines: ResolvedSaleLine[];
  foodTotal: number;
  deliveryFee: number | null;
  deliveryZoneName: string | null;
  total: number;
  breakdown: string[];
  uncataloguedItems?: Array<{ name: string; quantity: number; unitPrice?: number }>;
}

export interface DraftSaleData {
  items: SaleLineInput[];
  nota?: string;
  customShiftDate?: string; // YYYY-MM-DD
  zonaEnvio?: string | null;
  fleteMonto?: number | null;
  zonaNoReconocida?: string | null;
  _modifying?: boolean;
  _awaitingCustomDate?: boolean;
  _awaitingManualFee?: boolean;
  _awaitingDelivery?: boolean;
  _awaitingItemPriceIndex?: number | null;
  _awaitingItemPriceFor?: string | null;
}

export interface DaySummary {
  shiftDate: Date;
  shiftDateStr: string;
  salesTotal: number;
  salesCount: number;
  foodTotal: number;
  deliveryTotal: number;
  deliveryOrdersCount: number;
  cancelledTotal: number;
  cancelledCount: number;
  topProducts: Array<{ name: string; quantity: number; subtotal: number }>;
}

export interface CategorySummary {
  category: string;
  quantity: number;
  subtotal: number;
}

export interface PromoStatItem {
  name: string;
  quantity: number;
  subtotal: number;
}

export interface PromosSummary {
  promos: PromoStatItem[];
  totalQuantity: number;
  totalAmount: number;
}

export interface DrinkStatItem {
  name: string;
  quantity: number;
  subtotal: number;
}

export interface DrinksStatsSummary {
  totalQuantity: number;
  totalAmount: number;
  topDrink?: DrinkStatItem;
  drinks: DrinkStatItem[];
}

export interface StatsSummary {
  periodLabel: string;
  periodKey: string;
  salesTotal: number;
  salesCount: number;
  foodTotal: number;
  deliveryTotal: number;
  deliveryOrdersCount: number;
  averageTicket: number;
  cancelledCount: number;
  top3Products: Array<{ name: string; quantity: number; subtotal: number }>;
  categories: CategorySummary[];
  productsByCategory: Record<string, Array<{ name: string; quantity: number; subtotal: number }>>;
  promosSummary?: PromosSummary;
  drinksSummary?: DrinksStatsSummary;
}

export interface DeliveryZoneStat {
  zoneName: string;
  count: number;
  totalDeliveryFee: number;
}

export interface DeliveryStatsSummary {
  periodLabel: string;
  zones: DeliveryZoneStat[];
  totalOrders: number;
  totalDeliveryFees: number;
}

