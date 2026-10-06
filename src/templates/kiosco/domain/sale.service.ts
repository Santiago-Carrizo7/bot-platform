import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../../core/errors/errors.js';
import { ProductRepository } from '../persistence/product.repo.js';
import { SaleRepository, type SaleWithItems } from '../persistence/sale.repo.js';
import { CashRepository } from '../persistence/cash.repo.js';
import type { ResolvedSaleLine, SaleLineInput } from '../types.js';

export interface CreatedSale {
  sale: SaleWithItems;
  lines: ResolvedSaleLine[];
  /** Productos que quedaron con stock negativo (aviso, no bloqueo). */
  negativeStock: { productName: string; stock: number }[];
}

export class SaleService {
  constructor(
    private readonly db: PrismaClient,
    private readonly sales: SaleRepository,
    private readonly products: ProductRepository,
    private readonly cash: CashRepository
  ) {}

  /**
   * Registra una venta: resuelve productos, calcula el total, descuenta stock
   * y genera el movimiento de caja. Todo en una transacción.
   * El stock puede quedar en negativo (se avisa en la respuesta, no se bloquea).
   */
  async createSale(
    businessId: string,
    actorUserId: string,
    items: SaleLineInput[],
    note?: string,
    currency = 'ARS',
    now: Date = new Date()
  ): Promise<CreatedSale> {
    if (items.length === 0) throw new AppError('La venta necesita al menos un producto');

    // Resolver todos los productos antes de tocar la DB.
    const lines: ResolvedSaleLine[] = [];
    const missing: string[] = [];
    for (const item of items) {
      const product = await this.products.findByName(businessId, item.productName);
      if (!product) {
        missing.push(item.productName.trim());
        continue;
      }
      const unitPrice = Number(product.salePrice);
      lines.push({
        productId: product.id,
        productName: product.name,
        quantity: item.quantity,
        unitPrice,
        subtotal: round2(unitPrice * item.quantity),
      });
    }
    if (missing.length > 0) {
      throw new AppError(
        `No encontré estos productos: ${missing.map((m) => `"${m}"`).join(', ')}. Crealos primero ("crear producto ...").`
      );
    }

    const total = round2(lines.reduce((acc, l) => acc + l.subtotal, 0));
    const concept = lines.map((l) => `${formatQty(l.quantity)}x ${l.productName}`).join(', ');

    const negativeStock: { productName: string; stock: number }[] = [];
    const sale = await this.db.$transaction(async (tx) => {
      const created = await this.sales.create(businessId, actorUserId, total, lines, note, currency, tx);
      for (const line of lines) {
        const updated = await this.products.changeStock(line.productId, businessId, -line.quantity, tx);
        const stockLeft = Number(updated.stock);
        if (stockLeft < 0) negativeStock.push({ productName: line.productName, stock: stockLeft });
        await this.cash.addStockMovement(
          {
            businessId,
            productId: line.productId,
            productName: line.productName,
            quantity: -line.quantity,
            reason: 'VENTA',
            relatedType: 'sale',
            relatedId: created.id,
            userId: actorUserId,
          },
          tx
        );
      }
      await this.cash.addMovement(
        {
          businessId,
          userId: actorUserId,
          kind: 'IN',
          amount: total,
          concept: `Venta: ${concept}`.slice(0, 200),
          category: 'ventas',
          date: now,
          relatedType: 'sale',
          relatedId: created.id,
        },
        tx
      );
      return created;
    });

    return { sale, lines, negativeStock };
  }

  async listRecent(businessId: string, limit = 10): Promise<SaleWithItems[]> {
    return this.sales.listRecent(businessId, limit);
  }

  async getDailySalesTotal(businessId: string, refDate: Date = new Date()): Promise<{ total: number; count: number }> {
    const { start, end } = dayRange(refDate);
    return this.sales.getTotalByDateRange(businessId, start, end);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatQty(q: number): string {
  return Number.isInteger(q) ? String(q) : String(q);
}

function dayRange(ref: Date): { start: Date; end: Date } {
  const start = new Date(ref);
  start.setHours(0, 0, 0, 0);
  const end = new Date(ref);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}
