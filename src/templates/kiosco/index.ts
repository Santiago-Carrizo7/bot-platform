import type { PrismaClient } from '@prisma/client';
import type { CommandDef, TemplateDefinition } from '../../core/actions/registry.js';
import { ProductRepository } from './persistence/product.repo.js';
import { SaleRepository } from './persistence/sale.repo.js';
import { CashRepository } from './persistence/cash.repo.js';
import { ProductService } from './domain/product.service.js';
import { SaleService } from './domain/sale.service.js';
import { CashService } from './domain/cash.service.js';
import { buildKioscoActions } from './actions.js';
import { buildKioscoSystemPrompt } from './prompts.js';
import { formatCurrency, formatQty } from './format.js';

export interface KioscoTemplateDeps {
  db: PrismaClient;
}

export interface KioscoTemplateBundle {
  template: TemplateDefinition;
  /** Los productos los carga cada negocio (no hay seeds globales). */
  seedBusiness: (businessId: string) => Promise<void>;
}

const COMMANDS: CommandDef[] = [
  { command: 'venta', description: 'Registrar una venta', action: 'registrar_venta' },
  { command: 'stock', description: 'Consultar stock', action: 'consultar_stock' },
  { command: 'compra', description: 'Entró mercadería (compra)', action: 'registrar_compra' },
  { command: 'caja', description: 'Caja del día', action: 'consultar_caja_hoy' },
  { command: 'resumen', description: 'Resumen del mes', action: 'consultar_resumen_mes' },
  { command: 'ventas', description: 'Últimas ventas', action: 'consultar_ventas' },
  { command: 'producto', description: 'Crear un producto', action: 'crear_producto' },
  { command: 'ajustar', description: 'Contar o ajustar stock', action: 'fijar_stock' },
  { command: 'gasto', description: 'Sacar plata (gasto)', action: 'registrar_gasto' },
  { command: 'entrada', description: 'Entró plata', action: 'registrar_entrada' },
];

export function createKioscoTemplate(deps: KioscoTemplateDeps): KioscoTemplateBundle {
  const productRepo = new ProductRepository(deps.db);
  const saleRepo = new SaleRepository(deps.db);
  const cashRepo = new CashRepository(deps.db);

  const products = new ProductService(productRepo, cashRepo);
  const sales = new SaleService(deps.db, saleRepo, productRepo, cashRepo);
  const cash = new CashService(deps.db, cashRepo, productRepo);

  const template: TemplateDefinition = {
    id: 'kiosco',
    label: 'Kiosco',
    welcome: (businessName, firstName) =>
      [
        `👋 ¡Hola${firstName ? ` ${firstName}` : ''}! Soy el asistente de *${businessName}*.`,
        '',
        '🛒 *¿Cómo registrar una venta?*',
        'Escribime o mandame un *audio* como si hablaras con una persona:',
        '• *"Vendí 3 Coca y 2 alfajores"*',
        '• *"Vendí dos yerbas a 5000 cada una"*',
        '',
        '📌 Tenés botones abajo para lo más usado, o tocá /menu para ver todo.',
      ].join('\n'),
    systemPrompt: (businessName, referenceDate, hints) =>
      buildKioscoSystemPrompt(businessName, referenceDate, hints),
    resolveHints: async (tenant) => {
      const list = await products.list(tenant.business.id, { limit: 100 });
      if (list.length === 0) return '';
      const lines = list
        .map((p) => `- ${p.name} (${formatCurrency(Number(p.salePrice))}, stock ${formatQty(Number(p.stock))})`)
        .join('\n');
      // Acotar para no inflar el prompt.
      return `Productos del negocio:\n${lines.slice(0, 1500)}`;
    },
    actions: buildKioscoActions({ products, sales, cash }),
    commands: COMMANDS,
    replyMenu: [
      { label: '🛒 Vender', action: 'registrar_venta' },
      { label: '📦 Stock', action: 'consultar_stock' },
      { label: '➕ Entró mercadería', action: 'registrar_compra' },
      { label: '💰 Caja', action: 'consultar_caja_hoy' },
    ],
    menu: [
      { label: '🛒 Registrar una venta', action: 'registrar_venta' },
      { label: '➕ Crear producto', action: 'crear_producto' },
      { label: '📦 Entró mercadería (compra)', action: 'registrar_compra' },
      { label: '🔢 Contar / ajustar stock', action: 'fijar_stock' },
      { label: '📦 Consultar stock', action: 'consultar_stock' },
      { label: '💰 Caja de hoy', action: 'consultar_caja_hoy' },
      { label: '💸 Sacar plata (gasto)', action: 'registrar_gasto' },
      { label: '💵 Entró plata', action: 'registrar_entrada' },
      { label: '📊 Resumen del mes', action: 'consultar_resumen_mes' },
      { label: '🧾 Últimas ventas', action: 'consultar_ventas' },
      { label: '✏️ Cambiar producto', action: 'modificar_producto' },
      { label: '🗑️ Dar de baja producto', action: 'eliminar_producto' },
    ],
    menuCommands: [
      { command: 'venta', description: '🛒 Registrar una venta' },
      { command: 'stock', description: '📦 Consultar stock' },
      { command: 'compra', description: '📦 Entró mercadería' },
      { command: 'caja', description: '💰 Caja del día' },
      { command: 'resumen', description: '📊 Resumen del mes' },
      { command: 'producto', description: '➕ Crear un producto' },
    ],
  };

  return {
    template,
    seedBusiness: async (_businessId: string) => {
      // Sin seeds globales: cada kiosco carga sus propios productos.
    },
  };
}
