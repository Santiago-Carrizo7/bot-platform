import type { MoneyMovement, PrismaClient } from '@prisma/client';
import { AppError } from '../../../core/errors/errors.js';
import { ProductRepository } from '../persistence/product.repo.js';
import { CashRepository } from '../persistence/cash.repo.js';
import type { MoneyKind } from '../types.js';

export interface DaySummary {
  date: string;
  salesTotal: number;
  salesCount: number;
  totalIn: number;
  totalOut: number;
  net: number;
  countIn: number;
  countOut: number;
}

export class CashService {
  constructor(
    private readonly db: PrismaClient,
    private readonly cash: CashRepository,
    private readonly products: ProductRepository
  ) {}

  async moneyIn(
    businessId: string,
    actorUserId: string,
    data: { concept: string; amount: number; category?: string; date?: Date }
  ): Promise<MoneyMovement> {
    return this.movement(businessId, actorUserId, 'IN', data);
  }

  async moneyOut(
    businessId: string,
    actorUserId: string,
    data: { concept: string; amount: number; category?: string; date?: Date }
  ): Promise<MoneyMovement> {
    return this.movement(businessId, actorUserId, 'OUT', data);
  }

  private async movement(
    businessId: string,
    actorUserId: string,
    kind: MoneyKind,
    data: { concept: string; amount: number; category?: string; date?: Date }
  ): Promise<MoneyMovement> {
    if (data.amount <= 0) throw new AppError('El monto debe ser mayor a 0');
    if (!data.concept.trim()) throw new AppError('Falta la descripción del movimiento');
    return this.cash.addMovement({
      businessId,
      userId: actorUserId,
      kind,
      amount: data.amount,
      concept: data.concept,
      category: data.category,
      date: data.date,
    });
  }

  /**
   * Compra de mercadería o gasto: sale dinero y, si se indica producto +
   * cantidad, entra stock. Todo en una transacción.
   */
  async registerPurchase(
    businessId: string,
    actorUserId: string,
    data: { description: string; amount: number; productName?: string; quantity?: number; date?: Date },
    now: Date = new Date()
  ): Promise<{ movementId: string; stockAdded: { productName: string; stock: number } | null }> {
    if (data.amount <= 0) throw new AppError('El monto debe ser mayor a 0');
    if (!data.description.trim()) throw new AppError('Falta la descripción de la compra');

    let productId: string | undefined;
    let productName: string | undefined;
    if (data.productName) {
      const product = await this.products.findByName(businessId, data.productName);
      if (!product) {
        throw new AppError(`No encontré el producto "${data.productName.trim()}". Crealo primero.`);
      }
      productId = product.id;
      productName = product.name;
    }

    const result = await this.db.$transaction(async (tx) => {
      const purchase = await this.cash.createPurchase(
        {
          businessId,
          userId: actorUserId,
          description: data.description,
          amount: data.amount,
          productId,
          quantity: data.quantity,
          date: data.date ?? now,
        },
        tx
      );
      await this.cash.addMovement(
        {
          businessId,
          userId: actorUserId,
          kind: 'OUT',
          amount: data.amount,
          concept: `Compra: ${data.description}`.slice(0, 200),
          category: 'compras',
          date: data.date ?? now,
          relatedType: 'purchase',
          relatedId: purchase.id,
        },
        tx
      );
      let stockAdded: { productName: string; stock: number } | null = null;
      if (productId && productName && data.quantity) {
        const updated = await this.products.changeStock(productId, businessId, data.quantity, tx);
        await this.cash.addStockMovement(
          {
            businessId,
            productId,
            productName,
            quantity: data.quantity,
            reason: 'COMPRA',
            relatedType: 'purchase',
            relatedId: purchase.id,
            userId: actorUserId,
          },
          tx
        );
        stockAdded = { productName, stock: Number(updated.stock) };
      }
      return { movementId: purchase.id, stockAdded };
    });
    return result;
  }

  async getDaySummary(businessId: string, refDate: Date = new Date()): Promise<DaySummary> {
    const { start, end } = dayRange(refDate);
    const [cash, sales] = await Promise.all([
      this.cash.getTotalsByDateRange(businessId, start, end),
      this.db.sale.aggregate({
        where: { businessId, createdAt: { gte: start, lte: end } },
        _sum: { total: true },
        _count: { id: true },
      }),
    ]);
    return {
      date: refDate.toISOString().slice(0, 10),
      salesTotal: sales._sum.total ? Number(sales._sum.total) : 0,
      salesCount: sales._count.id,
      totalIn: cash.totalIn,
      totalOut: cash.totalOut,
      net: cash.totalIn - cash.totalOut,
      countIn: cash.countIn,
      countOut: cash.countOut,
    };
  }

  async getMonthSummary(businessId: string, referenceDate: Date = new Date()) {
    const year = referenceDate.getFullYear();
    const month = referenceDate.getMonth();
    const start = new Date(year, month, 1, 0, 0, 0, 0);
    const end = new Date(year, month + 1, 0, 23, 59, 59, 999);
    const [cash, sales] = await Promise.all([
      this.cash.getTotalsByDateRange(businessId, start, end),
      this.db.sale.aggregate({
        where: { businessId, createdAt: { gte: start, lte: end } },
        _sum: { total: true },
        _count: { id: true },
      }),
    ]);
    const monthNames = [
      'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
    ];
    return {
      year,
      month: month + 1,
      monthName: monthNames[month],
      salesTotal: sales._sum.total ? Number(sales._sum.total) : 0,
      salesCount: sales._count.id,
      totalIn: cash.totalIn,
      totalOut: cash.totalOut,
      net: cash.totalIn - cash.totalOut,
    };
  }
}

function dayRange(ref: Date): { start: Date; end: Date } {
  const start = new Date(ref);
  start.setHours(0, 0, 0, 0);
  const end = new Date(ref);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}
