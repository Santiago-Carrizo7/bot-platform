import type { PrismaClient } from '@prisma/client';
import type { CommandDef, TemplateDefinition } from '../../core/actions/registry.js';
import { ProductRepository } from './persistence/product.repo.js';
import { SaleRepository } from './persistence/sale.repo.js';
import { ProductService } from './domain/product.service.js';
import { SaleService } from './domain/sale.service.js';
import { buildRotiseriaActions } from './actions.js';
import { buildRotiseriaSystemPrompt } from './prompts.js';
import { formatCurrency } from './format.js';

export interface RotiseriaTemplateDeps {
  db: PrismaClient;
}

export interface RotiseriaTemplateBundle {
  template: TemplateDefinition;
  seedBusiness: (businessId: string) => Promise<void>;
}

const COMMANDS: CommandDef[] = [
  { command: 'venta', description: 'Registrar una venta', action: 'registrar_venta' },
  { command: 'dias', description: 'Control de días (cierre)', action: 'control_dias' },
  { command: 'stats', description: 'Estadísticas del negocio', action: 'consultar_estadisticas' },
  { command: 'anular', description: 'Anular última venta', action: 'anular_venta' },
  { command: 'precio', description: 'Cambiar precio', action: 'cambiar_precio' },
  { command: 'menu', description: 'Ver menú y precios', action: 'consultar_menu' },
  { command: 'ventas', description: 'Últimas ventas', action: 'consultar_ventas' },
  { command: 'producto', description: 'Crear producto', action: 'crear_producto' },
  { command: 'promo', description: 'Crear promo', action: 'crear_promo' },
];

export function createRotiseriaTemplate(deps: RotiseriaTemplateDeps): RotiseriaTemplateBundle {
  const productRepo = new ProductRepository(deps.db);
  const saleRepo = new SaleRepository(deps.db);

  const products = new ProductService(productRepo);
  const sales = new SaleService(saleRepo, products);

  const template: TemplateDefinition = {
    id: 'rotiseria',
    label: 'Rotisería / Sándwiches y Empanadas',
    welcome: (businessName, firstName) =>
      [
        `👋 ¡Hola${firstName ? ` ${firstName}` : ''}! Soy el asistente de *${businessName}*.`,
        '',
        '🥟 *¿Cómo registrar un pedido o venta?*',
        'Escribime o mandame un *audio* de forma natural:',
        '• *"1 docena de carne y una muzza"*',
        '• *"8 empanadas de carne y 4 de jamón y queso"*',
        '• *"Promo 1"*',
        '',
        '📌 Tenés botones abajo para lo más usado, o tocá /menu para ver todo.',
      ].join('\n'),
    systemPrompt: (businessName, referenceDate, hints) =>
      buildRotiseriaSystemPrompt(businessName, referenceDate, hints),
    resolveHints: async (tenant) => {
      const [productList, promoList] = await Promise.all([
        products.listProducts(tenant.business.id, { limit: 100 }),
        products.listPromos(tenant.business.id),
      ]);

      const lines: string[] = [];
      if (promoList.length > 0) {
        lines.push('Promos:');
        for (const pr of promoList) {
          lines.push(`- Promo "${pr.name}" (${formatCurrency(Number(pr.price))})`);
        }
      }
      if (productList.length > 0) {
        lines.push('Productos:');
        for (const p of productList) {
          const docena = p.priceDozen ? `, docena ${formatCurrency(Number(p.priceDozen))}` : '';
          lines.push(`- ${p.name} (unidad ${formatCurrency(Number(p.priceUnit))}${docena})`);
        }
      }

      if (lines.length === 0) return '';
      return lines.join('\n').slice(0, 1500);
    },
    actions: buildRotiseriaActions({ products, sales }),
    commands: COMMANDS,
    welcomeHint: async (tenant) => {
      const existing = await products.listProducts(tenant.business.id, { limit: 1 });
      if (existing.length > 0) return null;
      return (
        '⚠️ Todavía no cargaste comidas ni promos. Podés crear la primera escribiendo por ejemplo: ' +
        '*"Crear empanada de carne a 1500, docena 15000"*.'
      );
    },
    replyMenu: [
      { label: '📝 Registrar venta', action: 'registrar_venta' },
      { label: '📅 Control de días', action: 'control_dias' },
      { label: '📈 Estadísticas', action: 'consultar_estadisticas' },
      { label: '↩️ Anular venta', action: 'anular_venta' },
      { label: '🏷️ Cambiar precio', action: 'cambiar_precio' },
    ],
    menu: [
      { label: '📝 Registrar una venta', action: 'registrar_venta' },
      { label: '📅 Control de días (cierre)', action: 'control_dias' },
      { label: '📈 Estadísticas', action: 'consultar_estadisticas' },
      { label: '↩️ Anular última venta', action: 'anular_venta' },
      { label: '🏷️ Cambiar precio', action: 'cambiar_precio' },
      { label: '➕ Crear producto / empanada', action: 'crear_producto' },
      { label: '🎁 Crear promo', action: 'crear_promo' },
      { label: '📋 Ver menú y precios', action: 'consultar_menu' },
      { label: '🧾 Últimas ventas', action: 'consultar_ventas' },
    ],
    menuCommands: [
      { command: 'venta', description: '📝 Registrar venta' },
      { command: 'dias', description: '📅 Control de días' },
      { command: 'stats', description: '📈 Estadísticas' },
      { command: 'anular', description: '↩️ Anular venta' },
      { command: 'precio', description: '🏷️ Cambiar precio' },
      { command: 'menu', description: '📋 Ver menú' },
    ],
  };

  return {
    template,
    seedBusiness: async (businessId: string) => {
      await products.seedBaseCatalog(businessId);
    },
  };
}
