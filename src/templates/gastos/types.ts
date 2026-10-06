export const SYSTEM_CATEGORIES = [
  { name: 'transporte', icon: '🚌' },
  { name: 'comida', icon: '🍔' },
  { name: 'vivienda', icon: '🏠' },
  { name: 'servicios', icon: '💡' },
  { name: 'salud', icon: '💊' },
  { name: 'educacion', icon: '📚' },
  { name: 'entretenimiento', icon: '🎉' },
  { name: 'ropa', icon: '👕' },
  { name: 'compras', icon: '🛍️' },
  { name: 'impuestos', icon: '🏛️' },
  { name: 'otros', icon: '📦' },
] as const;

export const DEFAULT_CATEGORY_NAMES = SYSTEM_CATEGORIES.map((c) => c.name);

export interface CreateExpenseData {
  businessId: string;
  userId: string;
  amount: number;
  description: string;
  category: string;
  categoryId?: string;
  date: Date;
  installments?: number;
  currency?: string;
}

export interface MonthlyTotal {
  total: number;
  count: number;
  monthName: string;
  year: number;
}

export const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];
