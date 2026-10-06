import type { PrismaClient } from '@prisma/client';
import type { Router } from 'express';
import type { CommandDef, TemplateDefinition } from '../../core/actions/registry.js';
import type { MembershipService } from '../../core/identity/membership.service.js';
import { ExpenseRepository } from './persistence/expense.repo.js';
import { CategoryRepository } from './persistence/category.repo.js';
import { BudgetRepository } from './persistence/budget.repo.js';
import { ExpenseService } from './domain/expense.service.js';
import { CategoryService } from './domain/category.service.js';
import { BudgetService } from './domain/budget.service.js';
import { buildGastosActions } from './actions.js';
import { buildGastosSystemPrompt } from './prompts.js';
import { createGastosRouter } from './api.js';
import { seedGastosBusiness } from './seeds.js';

export interface GastosTemplateDeps {
  db: PrismaClient;
  memberships: MembershipService;
  apiSecret: string;
  apiTokenTtlSeconds?: number;
}

export interface GastosTemplateBundle {
  template: TemplateDefinition;
  router: Router;
  seedBusiness: (businessId: string) => Promise<void>;
}

const COMMANDS: CommandDef[] = [
  { command: 'gastos', description: 'Ver últimos gastos', action: 'consultar_ultimos' },
  { command: 'total', description: 'Total del mes', action: 'consultar_total' },
  { command: 'resumen', description: 'Resumen con desglose', action: 'consultar_resumen' },
  { command: 'presupuesto', description: 'Ver presupuestos', action: 'ver_presupuestos' },
  { command: 'categorias', description: 'Ver categorías', action: 'ver_categorias' },
  { command: 'vincular', description: 'Código para vincular', action: 'generar_vinculacion' },
];

const MENU_COMMANDS = [
  { command: 'gastos', description: '📋 Ver últimos gastos' },
  { command: 'total', description: '💰 Total del mes' },
  { command: 'resumen', description: '📊 Resumen con desglose' },
  { command: 'presupuesto', description: '📊 Ver presupuestos' },
  { command: 'categorias', description: '🏷️ Ver categorías' },
  { command: 'vincular', description: '📱 Código para vincular' },
];

export function createGastosTemplate(deps: GastosTemplateDeps): GastosTemplateBundle {
  const expenseRepo = new ExpenseRepository(deps.db);
  const categoryRepo = new CategoryRepository(deps.db);
  const budgetRepo = new BudgetRepository(deps.db);

  const categories = new CategoryService(categoryRepo);
  const expenses = new ExpenseService(expenseRepo, categories);
  const budgets = new BudgetService(budgetRepo, expenseRepo, categories);

  const template: TemplateDefinition = {
    id: 'gastos',
    label: 'Control de Gastos',
    welcome: (businessName, firstName) =>
      [
        `👋 ¡Hola${firstName ? ` ${firstName}` : ''}! Soy el asistente de *${businessName}*.`,
        '',
        '📝 *¿Cómo registrar un gasto?*',
        'Escribime o mandame un *audio* como si hablaras con una persona:',
        '• *"Gasté 5000 en Saeta"*',
        '• *"Ayer gasté 12000 en el supermercado"*',
        '',
        '📌 Tocá /ayuda para ver los comandos, o usá los botones de abajo.',
      ].join('\n'),
    systemPrompt: (businessName, referenceDate, hints) =>
      buildGastosSystemPrompt(businessName, referenceDate, hints),
    resolveHints: async (tenant) => {
      const names = await categories.getBusinessCategoryNames(tenant.business.id);
      return `Categorías disponibles para este negocio (usá EXACTAMENTE una de estas): [${names.map((n) => `"${n}"`).join(', ')}]`;
    },
    actions: buildGastosActions({
      expenses,
      categories,
      budgets,
      apiSecret: deps.apiSecret,
      apiTokenTtlSeconds: deps.apiTokenTtlSeconds ?? 180 * 24 * 3600,
    }),
    commands: COMMANDS,
    menu: [
      { label: '➕ Registrar gasto', action: 'registrar_gasto' },
      { label: '📋 Últimos', action: 'consultar_ultimos' },
      { label: '💰 Total del mes', action: 'consultar_total' },
      { label: '📊 Presupuestos', action: 'ver_presupuestos' },
    ],
    menuCommands: MENU_COMMANDS,
  };

  const router = createGastosRouter({ expenses, categories, budgets, memberships: deps.memberships });

  return {
    template,
    router,
    seedBusiness: (businessId: string) => seedGastosBusiness(categories, businessId),
  };
}
