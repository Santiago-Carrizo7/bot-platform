import type { ActionDef, ActionContext } from '../../core/actions/registry.js';
import { signApiToken } from '../../infrastructure/http/api-tokens.js';
import type { ExpenseService } from './domain/expense.service.js';
import type { CategoryService } from './domain/category.service.js';
import type { BudgetService } from './domain/budget.service.js';
import {
  EliminarGastoInput,
  EmptyInput,
  FijarPresupuestoInput,
  RegistrarGastoInput,
  ResumenInput,
  UltimosInput,
  type EliminarGastoInput as EliminarGasto,
  type EmptyInput as Empty,
  type FijarPresupuestoInput as FijarPresupuesto,
  type RegistrarGastoInput as RegistrarGasto,
  type ResumenInput as Resumen,
  type UltimosInput as Ultimos,
} from './schemas.js';
import { esc, formatCurrency, formatDate, getCategoryIcon, renderProgressBar } from './format.js';

export interface GastosActionDeps {
  expenses: ExpenseService;
  categories: CategoryService;
  budgets: BudgetService;
  apiSecret: string;
  apiTokenTtlSeconds: number;
}

function isOwner(ctx: ActionContext): boolean {
  return ctx.tenant.membership.role === 'OWNER';
}

export function buildGastosActions(deps: GastosActionDeps): ActionDef<unknown>[] {
  const { expenses, categories, budgets } = deps;

  const registrarGasto: ActionDef<RegistrarGasto> = {
    name: 'registrar_gasto',
    description:
      'Registra un gasto. Datos: amount (número positivo, monto total), description (texto breve), category (una de las disponibles), date (YYYY-MM-DD, por defecto hoy), installments (entero >= 1, por defecto 1), currency (ARS por defecto).',
    kind: 'write',
    input: RegistrarGastoInput,
    intro:
      'Para registrar el gasto necesito el *monto* y *en qué lo gastaste*. Podés mandarme todo junto, por ejemplo: *"Gasté 5000 en Saeta"*.',
    fieldPrompts: {
      amount: '¿Cuál es el *monto* del gasto?',
      description: '¿En qué lo gastaste? (una descripción breve)',
    },
    summarize: (i) => {
      const date = i.date ?? new Date().toISOString().slice(0, 10);
      const cuotas = i.installments > 1 ? `\n💳 Cuotas: *${i.installments}*` : '';
      return [
        'Entendí:',
        '',
        `💰 *${formatCurrency(i.amount, i.currency)}* en *${esc(i.category)}* ${getCategoryIcon(i.category)}`,
        `📝 Detalle: *${esc(i.description)}*`,
        `📅 Fecha: *${date}*${cuotas}`,
      ].join('\n');
    },
    handler: async (ctx, input) => {
      const expense = await expenses.create(ctx.tenant.business.id, ctx.actorUserId, {
        amount: input.amount,
        description: input.description,
        category: input.category,
        date: input.date,
        installments: input.installments,
        currency: input.currency,
      });
      const icon = getCategoryIcon(expense.category);
      const cuotas = expense.installments > 1 ? `\n💳 Cuotas: *${expense.installments}*` : '';
      return {
        reply: [
          `✅ Registré *${formatCurrency(Number(expense.amount), expense.currency)}* en *${esc(expense.category)}* ${icon}`,
          `📝 Detalle: *${esc(expense.description)}*`,
          `📅 Fecha: *${formatDate(expense.date)}*${cuotas}`,
        ].join('\n'),
        audit: {
          action: 'expense.created',
          entityType: 'expense',
          entityId: expense.id,
          metadata: { amount: Number(expense.amount), category: expense.category },
        },
      };
    },
  };

  const consultarUltimos: ActionDef<Ultimos> = {
    name: 'consultar_ultimos',
    description: 'Muestra los últimos gastos del negocio. Dato opcional: limit (1-10, por defecto 5).',
    kind: 'read',
    input: UltimosInput,
    handler: async (ctx, input) => {
      const list = await expenses.getLastExpenses(ctx.tenant.business.id, input.limit);
      if (list.length === 0) {
        return { reply: 'Aún no hay gastos registrados. Escribí un mensaje o mandá un audio para registrar el primero.' };
      }
      const lines = list.map((exp, index) => {
        const icon = getCategoryIcon(exp.category);
        const cuotas = exp.installments > 1 ? ` (${exp.installments} cuotas)` : '';
        return `${index + 1}. ${icon} *${formatCurrency(Number(exp.amount), exp.currency)}* — ${esc(exp.description)} (${esc(exp.category)})${cuotas} — _${formatDate(exp.date)}_`;
      });
      return { reply: [`📋 *Últimos ${list.length} gastos:*`, '', ...lines].join('\n') };
    },
  };

  const consultarTotal: ActionDef<Empty> = {
    name: 'consultar_total',
    description: 'Muestra el total gastado en el mes en curso. No necesita datos.',
    kind: 'read',
    input: EmptyInput,
    handler: async (ctx) => {
      const total = await expenses.getCurrentMonthTotal(ctx.tenant.business.id);
      if (total.count === 0) {
        return { reply: `📊 En *${total.monthName} ${total.year}* todavía no hay gastos registrados.` };
      }
      const countText = total.count === 1 ? '1 gasto registrado' : `${total.count} gastos registrados`;
      return {
        reply: [`📊 *Total de ${total.monthName} ${total.year}:*`, '', `💰 *${formatCurrency(total.total)}*`, `📑 ${countText}`].join('\n'),
      };
    },
  };

  const consultarResumen: ActionDef<Resumen> = {
    name: 'consultar_resumen',
    description:
      'Muestra el resumen del mes con desglose por categorías. Datos opcionales: year (ej. 2026), month (1-12). Sin datos usa el mes actual.',
    kind: 'read',
    input: ResumenInput,
    handler: async (ctx, input) => {
      let refDate = new Date();
      if (input.year && input.month) {
        refDate = new Date(Date.UTC(input.year, input.month - 1, 1, 12, 0, 0));
      }
      const summary = await expenses.getMonthlySummary(ctx.tenant.business.id, refDate);
      if (summary.count === 0) {
        return { reply: `📊 En *${summary.monthName} ${summary.year}* no hay gastos registrados.` };
      }
      const lines = Object.entries(summary.categories).map(([cat, info]) => {
        const icon = getCategoryIcon(cat);
        return `${icon} ${esc(cat)}: *${formatCurrency(info.total)}* (${info.count})`;
      });
      return {
        reply: [`📊 *Resumen de ${summary.monthName} ${summary.year}:*`, '', `💰 Total: *${formatCurrency(summary.total)}*`, '', ...lines].join('\n'),
      };
    },
  };

  const verPresupuestos: ActionDef<Empty> = {
    name: 'ver_presupuestos',
    description: 'Muestra los presupuestos mensuales del usuario con su progreso. No necesita datos.',
    kind: 'read',
    input: EmptyInput,
    handler: async (ctx) => {
      const list = await budgets.getBudgetsWithProgress(ctx.tenant.business.id, ctx.actorUserId);
      if (list.length === 0) {
        return {
          reply: [
            '📊 *Presupuestos Mensuales*',
            '',
            'Todavía no configuraste ningún tope mensual. Escribí por ejemplo: *"presupuesto comida 150000"*.',
          ].join('\n'),
        };
      }
      const lines = list.map((b) => {
        const icon = getCategoryIcon(b.category);
        const bar = renderProgressBar(b.percentageUsed);
        const statusIcon = b.isExceeded ? '⚠️' : b.percentageUsed >= 85 ? '🟡' : '🟢';
        const alert = b.isExceeded
          ? `\n   ❗ *Excedido por ${formatCurrency(Math.abs(b.remainingAmount), b.currency)}*`
          : ` (disponible: ${formatCurrency(b.remainingAmount, b.currency)})`;
        return `${icon} *${esc(b.category)}*: ${statusIcon} ${formatCurrency(b.spentAmount, b.currency)} / ${formatCurrency(b.budgetAmount, b.currency)} (${b.percentageUsed}%)\n   \`${bar}\`${alert}`;
      });
      return { reply: ['📊 *Presupuestos del Mes:*', '', ...lines].join('\n') };
    },
  };

  const fijarPresupuesto: ActionDef<FijarPresupuesto> = {
    name: 'fijar_presupuesto',
    description:
      'Fija o actualiza un presupuesto mensual por categoría. Datos: category (existente en el negocio), amount (número positivo).',
    kind: 'write',
    input: FijarPresupuestoInput,
    intro: 'Para fijar un presupuesto necesito la *categoría* y el *monto* mensual. Por ejemplo: *"presupuesto comida 150000"*.',
    fieldPrompts: {
      category: '¿Para qué *categoría* es el presupuesto?',
      amount: '¿Cuál es el *monto* mensual?',
    },
    summarize: (i) =>
      `Entendí:\n\n📊 Presupuesto mensual para *${esc(i.category)}* ${getCategoryIcon(i.category)}: *${formatCurrency(i.amount, i.currency)}*\n\n¿Confirmar?`,
    handler: async (ctx, input) => {
      await budgets.setBudget(ctx.tenant.business.id, ctx.actorUserId, input.category, input.amount, input.currency);
      return {
        reply: `✅ Presupuesto mensual para *${esc(input.category)}* ${getCategoryIcon(input.category)} fijado en *${formatCurrency(input.amount, input.currency)}*`,
        audit: { action: 'budget.set', entityType: 'budget', metadata: { category: input.category, amount: input.amount } },
      };
    },
  };

  const verCategorias: ActionDef<Empty> = {
    name: 'ver_categorias',
    description: 'Muestra las categorías de gastos del negocio. No necesita datos.',
    kind: 'read',
    input: EmptyInput,
    handler: async (ctx) => {
      const all = await categories.getBusinessCategories(ctx.tenant.business.id);
      const system = all.filter((c) => c.isSystem);
      const custom = all.filter((c) => !c.isSystem);
      const systemLines = system.map((c) => `• ${c.icon ?? '🏷️'} ${esc(c.name)}`).join('\n');
      const customLines =
        custom.length > 0
          ? custom.map((c) => `• ${c.icon ?? '🏷️'} *${esc(c.name)}*`).join('\n')
          : '_Ninguna creada todavía_';
      return {
        reply: ['🏷️ *Categorías:*', '', '*Generales:*', systemLines || '_—_', '', '*Personalizadas:*', customLines].join('\n'),
      };
    },
  };

  const generarVinculacion: ActionDef<Empty> = {
    name: 'generar_vinculacion',
    description: 'Genera un código para vincular la app u otro cliente con este negocio. No necesita datos.',
    kind: 'read',
    input: EmptyInput,
    handler: async (ctx) => {
      const token = signApiToken(
        deps.apiSecret,
        { userId: ctx.actorUserId, businessId: ctx.tenant.business.id },
        deps.apiTokenTtlSeconds
      );
      return {
        reply: [
          '📱 *Vincular con este negocio*',
          '',
          'Usá el siguiente código en el cliente que quieras conectar:',
          '',
          `\`${token}\``,
          '',
          '🔒 _Este código es personal. No lo compartas._',
        ].join('\n'),
        audit: { action: 'api_token.issued' },
      };
    },
  };

  const eliminarGasto: ActionDef<EliminarGasto> = {
    name: 'eliminar_gasto',
    description: 'Elimina un gasto por su identificador. Dato: id.',
    kind: 'write',
    input: EliminarGastoInput,
    summarize: () => '¿Confirmás eliminar ese gasto?',
    handler: async (ctx, input) => {
      await expenses.deleteExpense(ctx.tenant.business.id, ctx.actorUserId, isOwner(ctx), input.id);
      return { reply: '🗑️ Gasto eliminado.', audit: { action: 'expense.deleted', entityType: 'expense', entityId: input.id } };
    },
  };

  return [
    registrarGasto,
    consultarUltimos,
    consultarTotal,
    consultarResumen,
    verPresupuestos,
    fijarPresupuesto,
    verCategorias,
    generarVinculacion,
    eliminarGasto,
  ] as unknown as ActionDef<unknown>[];
}
