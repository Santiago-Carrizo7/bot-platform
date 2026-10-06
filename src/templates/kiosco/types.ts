export type MoneyKind = 'IN' | 'OUT';

export type StockReason = 'VENTA' | 'COMPRA' | 'AJUSTE' | 'CARGA_INICIAL';

export interface CreateProductData {
  businessId: string;
  name: string;
  salePrice: number;
  costPrice?: number;
  stock?: number;
  minStock?: number;
  unit?: string;
}

export interface SaleLineInput {
  productName: string;
  quantity: number;
}

export interface ResolvedSaleLine {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}
