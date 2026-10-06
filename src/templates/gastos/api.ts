import { Router } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../../infrastructure/http/server.js';
import type { MembershipService } from '../../core/identity/membership.service.js';
import type { ExpenseService } from './domain/expense.service.js';
import type { CategoryService } from './domain/category.service.js';
import type { BudgetService } from './domain/budget.service.js';

export interface GastosApiDeps {
  expenses: ExpenseService;
  categories: CategoryService;
  budgets: BudgetService;
  memberships: MembershipService;
}

const CreateExpenseSchema = z.object({
  amount: z.number().positive('El monto debe ser mayor a 0'),
  description: z.string().min(1, 'La descripción es requerida'),
  category: z.string().min(1, 'La categoría es requerida'),
  date: z.string().optional(),
  installments: z.number().int().min(1).optional(),
  currency: z.string().optional(),
});

const UpdateExpenseSchema = CreateExpenseSchema.partial();

/**
 * Rutas del template gastos. El negocio y el usuario salen del token HMAC
 * firmado (req.auth); nunca de parámetros del cliente.
 */
export function createGastosRouter(deps: GastosApiDeps): Router {
  const router = Router();
  const { expenses, categories, budgets, memberships } = deps;

  const ctxOf = (req: AuthenticatedRequest) => ({
    businessId: req.auth!.businessId,
    userId: req.auth!.userId,
  });

  const isOwner = async (req: AuthenticatedRequest): Promise<boolean> => {
    const m = await memberships.requireMembership(req.auth!.userId, req.auth!.businessId);
    return m.role === 'OWNER';
  };

  const serialize = (e: { amount: unknown; [k: string]: unknown }) => ({ ...e, amount: Number(e.amount) });

  // ---- Gastos ----
  router.get('/expenses', async (req, res) => {
    const { businessId } = ctxOf(req);
    const take = req.query.limit ? Number(req.query.limit) : 50;
    const skip = req.query.offset ? Number(req.query.offset) : 0;
    const list = await expenses.listExpenses(businessId, {
      take,
      skip,
      category: req.query.category as string | undefined,
      search: req.query.search as string | undefined,
      startDate: typeof req.query.startDate === 'string' ? new Date(req.query.startDate) : undefined,
      endDate: typeof req.query.endDate === 'string' ? new Date(req.query.endDate) : undefined,
    });
    res.json({ data: list.map(serialize) });
  });

  router.get('/expenses/:id', async (req, res) => {
    const { businessId } = ctxOf(req);
    const expense = await expenses.getExpense(businessId, String(req.params.id));
    res.json({ data: serialize(expense) });
  });

  router.post('/expenses', async (req, res) => {
    const { businessId, userId } = ctxOf(req);
    const body = CreateExpenseSchema.parse(req.body);
    const expense = await expenses.create(businessId, userId, body);
    res.status(201).json({ data: serialize(expense) });
  });

  router.put('/expenses/:id', async (req, res) => {
    const { businessId, userId } = ctxOf(req);
    const body = UpdateExpenseSchema.parse(req.body);
    const updated = await expenses.updateExpense(businessId, userId, await isOwner(req), String(req.params.id), body);
    res.json({ data: serialize(updated) });
  });

  router.delete('/expenses/:id', async (req, res) => {
    const { businessId, userId } = ctxOf(req);
    await expenses.deleteExpense(businessId, userId, await isOwner(req), String(req.params.id));
    res.status(204).send();
  });

  router.get('/summary', async (req, res) => {
    const { businessId } = ctxOf(req);
    let refDate = new Date();
    if (req.query.year && req.query.month) {
      const y = Number(req.query.year);
      const m = Number(req.query.month);
      if (!isNaN(y) && !isNaN(m) && m >= 1 && m <= 12) {
        refDate = new Date(Date.UTC(y, m - 1, 1, 12, 0, 0));
      }
    }
    res.json({ data: await expenses.getMonthlySummary(businessId, refDate) });
  });

  router.get('/analytics', async (req, res) => {
    const { businessId } = ctxOf(req);
    const months = req.query.months ? Number(req.query.months) : 6;
    res.json({ data: { monthlyHistory: await expenses.getMonthlyHistory(businessId, months) } });
  });

  // ---- Categorías ----
  router.get('/categories', async (req, res) => {
    res.json({ data: await categories.getBusinessCategories(ctxOf(req).businessId) });
  });

  router.post('/categories', async (req, res) => {
    const body = z.object({ name: z.string().min(1), icon: z.string().optional() }).parse(req.body);
    const created = await categories.createCustom(ctxOf(req).businessId, body.name, body.icon);
    res.status(201).json({ data: created });
  });

  router.put('/categories/:id', async (req, res) => {
    const body = z.object({ name: z.string().min(1).optional(), icon: z.string().optional() }).parse(req.body);
    const updated = await categories.updateCustom(ctxOf(req).businessId, String(req.params.id), body);
    res.json({ data: updated });
  });

  router.patch('/categories/:id/deactivate', async (req, res) => {
    const updated = await categories.deactivate(ctxOf(req).businessId, String(req.params.id));
    res.json({ data: updated });
  });

  // ---- Presupuestos (por usuario dentro del negocio) ----
  router.get('/budgets', async (req, res) => {
    const { businessId, userId } = ctxOf(req);
    const list = await budgets.getBudgetsWithProgress(businessId, userId);
    res.json({ data: list });
  });

  router.post('/budgets', async (req, res) => {
    const { businessId, userId } = ctxOf(req);
    const body = z
      .object({ category: z.string().min(1), amount: z.number().positive(), currency: z.string().optional() })
      .parse(req.body);
    const created = await budgets.setBudget(businessId, userId, body.category, body.amount, body.currency);
    res.status(201).json({ data: { ...created, amount: Number(created.amount) } });
  });

  router.delete('/budgets/:id', async (req, res) => {
    const { businessId, userId } = ctxOf(req);
    await budgets.deleteBudget(businessId, userId, String(req.params.id));
    res.status(204).send();
  });

  return router;
}
