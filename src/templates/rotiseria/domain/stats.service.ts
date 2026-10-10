import type { SaleRepository, RotiseriaSaleWithItems } from '../persistence/sale.repo.js';
import type { CategorySummary, StatsSummary } from '../types.js';
import { formatDateOnly, round2 } from '../format.js';
import { getShiftDate } from './shift.js';

export class StatsService {
  constructor(private readonly repo: SaleRepository) {}

  async getStats(
    businessId: string,
    period: string = 'esta_semana',
    now: Date = new Date(),
    timezone = 'America/Argentina/Buenos_Aires'
  ): Promise<StatsSummary> {
    const currentShift = getShiftDate(now, timezone);
    let sales: RotiseriaSaleWithItems[] = [];
    let periodLabel = 'Últimos 7 días';
    const periodKey = period;

    if (period === 'semana' || period === 'esta_semana') {
      const startDate = new Date(currentShift);
      startDate.setUTCDate(startDate.getUTCDate() - 6);
      sales = await this.repo.findByDateRange(businessId, startDate, currentShift);
      periodLabel = 'Últimos 7 días';
    } else if (period === 'semana_cerrada') {
      // Semana lunes a domingo
      const day = currentShift.getUTCDay(); // 0 = dom, 1 = lun, ...
      const diffToMonday = day === 0 ? 6 : day - 1;
      const monday = new Date(currentShift);
      monday.setUTCDate(monday.getUTCDate() - diffToMonday);
      const sunday = new Date(monday);
      sunday.setUTCDate(sunday.getUTCDate() + 6);

      sales = await this.repo.findByDateRange(businessId, monday, sunday);
      periodLabel = `Semana (${formatDateOnly(monday)} a ${formatDateOnly(sunday)})`;
    } else if (period === 'mes' || period === 'este_mes') {
      const year = currentShift.getUTCFullYear();
      const month = currentShift.getUTCMonth();
      const firstDay = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
      const lastDay = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));
      sales = await this.repo.findByDateRange(businessId, firstDay, lastDay);
      const monthName = firstDay.toLocaleDateString('es-AR', { month: 'long', timeZone: 'UTC' });
      periodLabel = `Este mes (${monthName} ${year})`;
    } else if (period.startsWith('mes:') || period.startsWith('mes_especifico:')) {
      const val = period.includes(':') ? period.split(':')[1] : '';
      const [yStr, mStr] = val.split('-');
      const y = parseInt(yStr, 10);
      const m = parseInt(mStr, 10) - 1;
      if (!isNaN(y) && !isNaN(m)) {
        const firstDay = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
        const lastDay = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
        sales = await this.repo.findByDateRange(businessId, firstDay, lastDay);
        periodLabel = `Mes ${val}`;
      } else {
        sales = await this.repo.findAll(businessId);
        periodLabel = 'Histórico acumulado';
      }
    } else if (period === 'historico') {
      sales = await this.repo.findAll(businessId);
      periodLabel = 'Histórico acumulado';
    } else {
      const startDate = new Date(currentShift);
      startDate.setUTCDate(startDate.getUTCDate() - 6);
      sales = await this.repo.findByDateRange(businessId, startDate, currentShift);
      periodLabel = 'Últimos 7 días';
    }

    let salesTotal = 0;
    let salesCount = 0;
    let cancelledCount = 0;

    const productCounts: Record<string, { quantity: number; subtotal: number; category: string }> = {};
    const categoryTotals: Record<string, { quantity: number; subtotal: number }> = {};
    const productsByCategory: Record<string, Record<string, { quantity: number; subtotal: number }>> = {};

    for (const sale of sales) {
      if (sale.isCancelled) {
        cancelledCount++;
      } else {
        salesTotal = round2(salesTotal + Number(sale.total));
        salesCount++;

        for (const item of sale.items) {
          const qty = Number(item.quantity);
          const sub = Number(item.subtotal);
          const cat = (item.category || 'general').toLowerCase().trim();

          if (!productCounts[item.name]) {
            productCounts[item.name] = { quantity: 0, subtotal: 0, category: cat };
          }
          productCounts[item.name].quantity += qty;
          productCounts[item.name].subtotal = round2(productCounts[item.name].subtotal + sub);

          if (!categoryTotals[cat]) {
            categoryTotals[cat] = { quantity: 0, subtotal: 0 };
          }
          categoryTotals[cat].quantity += qty;
          categoryTotals[cat].subtotal = round2(categoryTotals[cat].subtotal + sub);

          if (!productsByCategory[cat]) {
            productsByCategory[cat] = {};
          }
          if (!productsByCategory[cat][item.name]) {
            productsByCategory[cat][item.name] = { quantity: 0, subtotal: 0 };
          }
          productsByCategory[cat][item.name].quantity += qty;
          productsByCategory[cat][item.name].subtotal = round2(productsByCategory[cat][item.name].subtotal + sub);
        }
      }
    }

    const averageTicket = salesCount > 0 ? round2(salesTotal / salesCount) : 0;

    const top3Products = Object.entries(productCounts)
      .map(([name, data]) => ({ name, quantity: data.quantity, subtotal: data.subtotal }))
      .sort((a, b) => b.quantity - a.quantity || b.subtotal - a.subtotal)
      .slice(0, 3);

    const categories: CategorySummary[] = Object.entries(categoryTotals)
      .map(([cat, data]) => ({ category: cat, quantity: data.quantity, subtotal: data.subtotal }))
      .sort((a, b) => b.subtotal - a.subtotal);

    const formattedProductsByCategory: Record<string, Array<{ name: string; quantity: number; subtotal: number }>> = {};
    for (const [cat, map] of Object.entries(productsByCategory)) {
      formattedProductsByCategory[cat] = Object.entries(map)
        .map(([name, data]) => ({ name, quantity: data.quantity, subtotal: data.subtotal }))
        .sort((a, b) => b.quantity - a.quantity || b.subtotal - a.subtotal);
    }

    return {
      periodLabel,
      periodKey,
      salesTotal,
      salesCount,
      averageTicket,
      cancelledCount,
      top3Products,
      categories,
      productsByCategory: formattedProductsByCategory,
    };
  }

  async getRecentShiftsSummary(
    businessId: string,
    now: Date = new Date(),
    daysCount = 7,
    timezone = 'America/Argentina/Buenos_Aires'
  ): Promise<ShiftDaySummary[]> {
    const todayShift = getShiftDate(now, timezone);
    const startDate = new Date(todayShift);
    startDate.setUTCDate(startDate.getUTCDate() - (daysCount - 1));

    const sales = await this.repo.findByDateRange(businessId, startDate, todayShift);
    const byDate = new Map<string, { count: number; total: number }>();

    for (const sale of sales) {
      if (sale.isCancelled) continue;
      const key = sale.shiftDate.toISOString().slice(0, 10);
      const existing = byDate.get(key) ?? { count: 0, total: 0 };
      existing.count++;
      existing.total = round2(existing.total + Number(sale.total));
      byDate.set(key, existing);
    }

    const result: ShiftDaySummary[] = [];
    for (let i = 0; i < daysCount; i++) {
      const d = new Date(todayShift);
      d.setUTCDate(d.getUTCDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const data = byDate.get(dateStr) ?? { count: 0, total: 0 };
      result.push({
        date: d,
        dateStr,
        count: data.count,
        total: data.total,
      });
    }

    return result;
  }
}

export interface ShiftDaySummary {
  date: Date;
  dateStr: string;
  count: number;
  total: number;
}
