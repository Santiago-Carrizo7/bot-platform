import { AppError } from '../../../core/errors/errors.js';
import type { DaySummary, PricingResult, SaleLineInput, StatsSummary } from '../types.js';
import { calculatePricing } from './pricing.js';
import { getShiftDate, getShiftDateRange, formatShiftLabel } from './shift.js';
import { ProductService } from './product.service.js';
import { SaleRepository, type RotiseriaSaleWithItems } from '../persistence/sale.repo.js';
import { formatDateOnly, round2 } from '../format.js';

export interface CreatedRotiseriaSale {
  sale: RotiseriaSaleWithItems;
  pricing: PricingResult;
}

export class SaleService {
  constructor(
    private readonly repo: SaleRepository,
    private readonly products: ProductService
  ) {}

  async createSale(
    businessId: string,
    actorUserId: string,
    items: SaleLineInput[],
    note?: string,
    now: Date = new Date(),
    timezone = 'America/Argentina/Buenos_Aires'
  ): Promise<CreatedRotiseriaSale> {
    const catalog = await this.products.getCatalogLookup(businessId);
    const pricing = calculatePricing(items, catalog);
    const shiftDate = getShiftDate(now, timezone);

    const sale = await this.repo.create(
      businessId,
      actorUserId,
      pricing.total,
      shiftDate,
      pricing.lines,
      note
    );

    return { sale, pricing };
  }

  async cancelSale(
    businessId: string,
    actorUserId: string,
    saleId?: string,
    reason?: string,
    now: Date = new Date()
  ): Promise<RotiseriaSaleWithItems> {
    let sale: RotiseriaSaleWithItems | null = null;
    if (saleId) {
      sale = await this.repo.findById(saleId, businessId);
      if (!sale) {
        throw new AppError(`No se encontró la venta con ID "${saleId}".`);
      }
    } else {
      sale = await this.repo.findLastActive(businessId);
      if (!sale) {
        throw new AppError('No hay ventas activas recientes para anular.');
      }
    }

    if (sale.isCancelled) {
      throw new AppError('Esta venta ya se encuentra anulada.');
    }

    return this.repo.cancel(sale.id, businessId, actorUserId, reason, now);
  }

  async getDaySummary(
    businessId: string,
    targetDate?: Date,
    now: Date = new Date(),
    timezone = 'America/Argentina/Buenos_Aires'
  ): Promise<DaySummary> {
    const shiftDate = targetDate ?? getShiftDate(now, timezone);
    const sales = await this.repo.findByShiftDate(businessId, shiftDate);

    let salesTotal = 0;
    let salesCount = 0;
    let cancelledTotal = 0;
    let cancelledCount = 0;
    const productCounts: Record<string, { quantity: number; subtotal: number }> = {};

    for (const sale of sales) {
      if (sale.isCancelled) {
        cancelledTotal = round2(cancelledTotal + Number(sale.total));
        cancelledCount++;
      } else {
        salesTotal = round2(salesTotal + Number(sale.total));
        salesCount++;

        for (const item of sale.items) {
          if (!productCounts[item.name]) {
            productCounts[item.name] = { quantity: 0, subtotal: 0 };
          }
          productCounts[item.name].quantity += Number(item.quantity);
          productCounts[item.name].subtotal = round2(productCounts[item.name].subtotal + Number(item.subtotal));
        }
      }
    }

    const topProducts = Object.entries(productCounts)
      .map(([name, data]) => ({ name, quantity: data.quantity, subtotal: data.subtotal }))
      .sort((a, b) => b.quantity - a.quantity);

    return {
      shiftDate,
      shiftDateStr: formatShiftLabel(shiftDate, now, timezone),
      salesTotal,
      salesCount,
      cancelledTotal,
      cancelledCount,
      topProducts,
    };
  }

  async getStatsSummary(
    businessId: string,
    period: 'semana' | 'mes' = 'semana',
    now: Date = new Date(),
    timezone = 'America/Argentina/Buenos_Aires'
  ): Promise<StatsSummary> {
    const currentShift = getShiftDate(now, timezone);
    const daysBack = period === 'mes' ? 30 : 7;

    const startDate = new Date(currentShift);
    startDate.setUTCDate(startDate.getUTCDate() - (daysBack - 1));

    const sales = await this.repo.findByDateRange(businessId, startDate, currentShift);

    let salesTotal = 0;
    let salesCount = 0;
    let cancelledCount = 0;
    const productCounts: Record<string, { quantity: number; subtotal: number }> = {};

    for (const sale of sales) {
      if (sale.isCancelled) {
        cancelledCount++;
      } else {
        salesTotal = round2(salesTotal + Number(sale.total));
        salesCount++;

        for (const item of sale.items) {
          if (!productCounts[item.name]) {
            productCounts[item.name] = { quantity: 0, subtotal: 0 };
          }
          productCounts[item.name].quantity += Number(item.quantity);
          productCounts[item.name].subtotal = round2(productCounts[item.name].subtotal + Number(item.subtotal));
        }
      }
    }

    const averageTicket = salesCount > 0 ? round2(salesTotal / salesCount) : 0;
    const topProducts = Object.entries(productCounts)
      .map(([name, data]) => ({ name, quantity: data.quantity, subtotal: data.subtotal }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5);

    const periodLabel = period === 'mes' ? 'Últimos 30 días' : 'Últimos 7 días';

    return {
      periodLabel,
      salesTotal,
      salesCount,
      averageTicket,
      cancelledCount,
      topProducts,
    };
  }

  async listRecentSales(businessId: string, limit = 10): Promise<RotiseriaSaleWithItems[]> {
    return this.repo.listRecent(businessId, limit);
  }

  async findLastActiveSale(businessId: string): Promise<RotiseriaSaleWithItems | null> {
    return this.repo.findLastActive(businessId);
  }
}
