import { AppError } from '../../../core/errors/errors.js';
import type { DaySummary, PricingResult, SaleLineInput, StatsSummary } from '../types.js';
import { calculatePricing } from './pricing.js';
import { getShiftDate, formatShiftLabel } from './shift.js';
import { ProductService } from './product.service.js';
import { StatsService } from './stats.service.js';
import { SaleRepository, type RotiseriaSaleWithItems } from '../persistence/sale.repo.js';
import { round2 } from '../format.js';

export interface CreatedRotiseriaSale {
  sale: RotiseriaSaleWithItems;
  pricing: PricingResult;
}

export class SaleService {
  private readonly stats: StatsService;

  constructor(
    private readonly repo: SaleRepository,
    private readonly products: ProductService,
    stats?: StatsService
  ) {
    this.stats = stats ?? new StatsService(repo);
  }

  async createSale(
    businessId: string,
    actorUserId: string,
    items: SaleLineInput[],
    note?: string,
    now: Date = new Date(),
    timezone = 'America/Argentina/Buenos_Aires',
    customShiftDate?: Date
  ): Promise<CreatedRotiseriaSale> {
    const catalog = await this.products.getCatalogLookup(businessId);
    const pricing = calculatePricing(items, catalog);
    const shiftDate = customShiftDate ?? getShiftDate(now, timezone);

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
      shiftDateStr: formatShiftLabel(shiftDate),
      salesTotal,
      salesCount,
      cancelledTotal,
      cancelledCount,
      topProducts,
    };
  }

  async getStatsSummary(
    businessId: string,
    period: string = 'esta_semana',
    now: Date = new Date(),
    timezone = 'America/Argentina/Buenos_Aires'
  ): Promise<StatsSummary> {
    return this.stats.getStats(businessId, period, now, timezone);
  }

  async listRecentSales(businessId: string, limit = 10): Promise<RotiseriaSaleWithItems[]> {
    return this.repo.listRecent(businessId, limit);
  }

  async findLastActiveSale(businessId: string): Promise<RotiseriaSaleWithItems | null> {
    return this.repo.findLastActive(businessId);
  }

  async findSaleById(saleId: string, businessId: string): Promise<RotiseriaSaleWithItems | null> {
    return this.repo.findById(saleId, businessId);
  }

  async findByShiftDate(businessId: string, shiftDate: Date): Promise<RotiseriaSaleWithItems[]> {
    return this.repo.findByShiftDate(businessId, shiftDate);
  }

  async getRecentShiftsSummary(
    businessId: string,
    now: Date = new Date(),
    daysCount = 7,
    timezone = 'America/Argentina/Buenos_Aires'
  ) {
    return this.stats.getRecentShiftsSummary(businessId, now, daysCount, timezone);
  }
}
