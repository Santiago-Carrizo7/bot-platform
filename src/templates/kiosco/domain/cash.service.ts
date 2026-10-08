import type { MoneyMovement } from '@prisma/client';
import { AppError } from '../../../core/errors/errors.js';
import { CashRepository } from '../persistence/cash.repo.js';
import type { ExpenseInput, PeriodSummary, PricingCalculation, SaleInput } from '../types.js';

export class CashService {
  constructor(private readonly cash: CashRepository) {}

  /**
   * Registra una venta rápida (dinero que entra).
   * La fecha puede ser retroactiva si se envía explícitamente.
   */
  async recordSale(
    businessId: string,
    actorUserId: string,
    data: SaleInput
  ): Promise<MoneyMovement> {
    if (data.monto <= 0) throw new AppError('El monto de la venta debe ser mayor a 0');
    const concept = data.nota?.trim() ? `Venta: ${data.nota.trim()}` : 'Venta';
    return this.cash.addMovement({
      businessId,
      userId: actorUserId,
      kind: 'IN',
      amount: data.monto,
      concept,
      category: 'Ventas',
      date: data.fecha,
    });
  }

  /**
   * Registra un gasto o compra a proveedor (dinero que sale).
   * Distingue la categoría si fue provista o la infiere del concepto.
   */
  async recordExpense(
    businessId: string,
    actorUserId: string,
    data: ExpenseInput
  ): Promise<MoneyMovement> {
    if (data.monto <= 0) throw new AppError('El monto del gasto debe ser mayor a 0');
    if (!data.concepto.trim()) throw new AppError('Falta la descripción del gasto');

    const category = data.categoria?.trim() || inferCategory(data.concepto);

    return this.cash.addMovement({
      businessId,
      userId: actorUserId,
      kind: 'OUT',
      amount: data.monto,
      concept: data.concepto.trim(),
      category,
      date: data.fecha,
    });
  }

  /**
   * Deshace / anula el último movimiento del usuario en este negocio.
   * Retorna el movimiento anulado (o null si no hay ninguno).
   */
  async undoLast(businessId: string, actorUserId: string): Promise<MoneyMovement | null> {
    return this.cash.undoLastMovement(businessId, actorUserId);
  }

  /**
   * Lista los movimientos más recientes (ventas y gastos) en orden cronológico.
   */
  async listRecent(businessId: string, limit = 10): Promise<MoneyMovement[]> {
    return this.cash.listRecent(businessId, limit);
  }

  /**
   * Resumen del día: ventas, gastos, cantidad de operaciones y balance de caja.
   */
  async getDaySummary(businessId: string, refDate: Date = new Date()): Promise<PeriodSummary> {
    const { start, end } = dayRange(refDate);
    const totals = await this.cash.getTotalsByDateRange(businessId, start, end);
    return {
      periodLabel: 'hoy',
      ventasTotal: totals.totalIn,
      ventasCount: totals.countIn,
      gastosTotal: totals.totalOut,
      gastosCount: totals.countOut,
      balanceCaja: round2(totals.totalIn - totals.totalOut),
    };
  }

  /**
   * Resumen de la semana en curso (desde el lunes 00:00).
   */
  async getWeekSummary(businessId: string, refDate: Date = new Date()): Promise<PeriodSummary> {
    const { start, end } = weekRange(refDate);
    const totals = await this.cash.getTotalsByDateRange(businessId, start, end);
    return {
      periodLabel: 'esta semana',
      ventasTotal: totals.totalIn,
      ventasCount: totals.countIn,
      gastosTotal: totals.totalOut,
      gastosCount: totals.countOut,
      balanceCaja: round2(totals.totalIn - totals.totalOut),
    };
  }

  /**
   * Resumen del mes en curso.
   */
  async getMonthSummary(businessId: string, refDate: Date = new Date()): Promise<PeriodSummary> {
    const { start, end } = monthRange(refDate);
    const totals = await this.cash.getTotalsByDateRange(businessId, start, end);
    return {
      periodLabel: 'este mes',
      ventasTotal: totals.totalIn,
      ventasCount: totals.countIn,
      gastosTotal: totals.totalOut,
      gastosCount: totals.countOut,
      balanceCaja: round2(totals.totalIn - totals.totalOut),
    };
  }

  /**
   * Calculadora de precio de venta:
   * Recargo (markup): Precio = Costo * (1 + porcentaje / 100)
   * Margen: Precio = Costo / (1 - porcentaje / 100)
   */
  calculatePrice(opts: {
    costoTotal?: number;
    cantidad?: number;
    costoUnitario?: number;
    porcentaje: number;
    tipo: 'margen' | 'recargo';
  }): PricingCalculation {
    let costo = opts.costoUnitario;
    if (costo === undefined) {
      if (opts.costoTotal !== undefined && opts.cantidad !== undefined && opts.cantidad > 0) {
        costo = opts.costoTotal / opts.cantidad;
      } else {
        throw new AppError('Indicá el costo unitario o el costo total y la cantidad.');
      }
    }
    if (costo <= 0) throw new AppError('El costo debe ser mayor a 0');
    if (opts.porcentaje < 0) throw new AppError('El porcentaje no puede ser negativo');

    let precioSugerido: number;
    if (opts.tipo === 'recargo') {
      precioSugerido = round2(costo * (1 + opts.porcentaje / 100));
    } else {
      if (opts.porcentaje >= 100) {
        throw new AppError('El margen sobre precio de venta debe ser menor al 100%.');
      }
      precioSugerido = round2(costo / (1 - opts.porcentaje / 100));
    }

    const gananciaUnitaria = round2(precioSugerido - costo);
    const gananciaLote =
      opts.cantidad !== undefined && opts.cantidad > 0
        ? round2(gananciaUnitaria * opts.cantidad)
        : undefined;

    return {
      costoUnitario: round2(costo),
      precioSugerido,
      tipo: opts.tipo,
      porcentaje: opts.porcentaje,
      gananciaUnitaria,
      gananciaLote,
      cantidad: opts.cantidad,
      costoTotal: opts.costoTotal ? round2(opts.costoTotal) : undefined,
    };
  }
}

export function inferCategory(concept: string): string {
  const lower = concept.toLowerCase();
  if (lower.includes('proveedor') || lower.includes('mayorista')) return 'Proveedores';
  if (
    lower.includes('luz') ||
    lower.includes('gas') ||
    lower.includes('internet') ||
    lower.includes('agua') ||
    lower.includes('servicio')
  ) {
    return 'Servicios';
  }
  if (lower.includes('alquiler')) return 'Alquiler';
  if (
    lower.includes('impuesto') ||
    lower.includes('afip') ||
    lower.includes('rentas') ||
    lower.includes('monotributo')
  ) {
    return 'Impuestos';
  }
  if (
    lower.includes('nafta') ||
    lower.includes('flete') ||
    lower.includes('viaje') ||
    lower.includes('transporte') ||
    lower.includes('colectivo')
  ) {
    return 'Transporte';
  }
  if (lower.includes('supermercado') || lower.includes('super') || lower.includes('chino')) {
    return 'Supermercado';
  }
  if (
    lower.includes('coca') ||
    lower.includes('alfajor') ||
    lower.includes('cigarrillo') ||
    lower.includes('mercader') ||
    lower.includes('golosina') ||
    lower.includes('galletita') ||
    lower.includes('bebida') ||
    lower.includes('hielo') ||
    lower.includes('pan')
  ) {
    return 'Mercadería';
  }
  return 'Otros';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function dayRange(ref: Date): { start: Date; end: Date } {
  const start = new Date(ref);
  start.setHours(0, 0, 0, 0);
  const end = new Date(ref);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function weekRange(ref: Date): { start: Date; end: Date } {
  const start = new Date(ref);
  const day = start.getDay(); // 0 domingo, 1 lunes...
  const diff = day === 0 ? -6 : 1 - day; // inicio el lunes
  start.setDate(start.getDate() + diff);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function monthRange(ref: Date): { start: Date; end: Date } {
  const year = ref.getFullYear();
  const month = ref.getMonth();
  const start = new Date(year, month, 1, 0, 0, 0, 0);
  const end = new Date(year, month + 1, 0, 23, 59, 59, 999);
  return { start, end };
}
