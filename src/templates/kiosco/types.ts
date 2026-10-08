export type MoneyKind = 'IN' | 'OUT';

export const EXPENSE_CATEGORIES = [
  'Proveedores',
  'Mercadería',
  'Servicios',
  'Alquiler',
  'Impuestos',
  'Transporte',
  'Supermercado',
  'Otros',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export interface SaleInput {
  monto: number;
  nota?: string;
  fecha?: Date;
}

export interface ExpenseInput {
  monto: number;
  concepto: string;
  categoria?: string;
  fecha?: Date;
}

export interface PricingCalculation {
  costoUnitario: number;
  precioSugerido: number;
  tipo: 'margen' | 'recargo';
  porcentaje: number;
  gananciaUnitaria: number;
  gananciaLote?: number;
  cantidad?: number;
  costoTotal?: number;
}

export interface PeriodSummary {
  periodLabel: string;
  ventasTotal: number;
  ventasCount: number;
  gastosTotal: number;
  gastosCount: number;
  balanceCaja: number;
}
