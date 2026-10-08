import type { PrismaClient } from '@prisma/client';
import type { CommandDef, TemplateDefinition } from '../../core/actions/registry.js';
import { CashRepository } from './persistence/cash.repo.js';
import { CashService } from './domain/cash.service.js';
import { buildKioscoActions } from './actions.js';
import { buildKioscoSystemPrompt } from './prompts.js';

export interface KioscoTemplateDeps {
  db: PrismaClient;
}

export interface KioscoTemplateBundle {
  template: TemplateDefinition;
  seedBusiness: (businessId: string) => Promise<void>;
}

const COMMANDS: CommandDef[] = [
  { command: 'venta', description: 'Registrar una venta', action: 'registrar_venta' },
  { command: 'ventas', description: 'Modo continuo de ventas', action: 'modo_ventas' },
  { command: 'gasto', description: 'Registrar un gasto', action: 'registrar_gasto' },
  { command: 'gastos', description: 'Modo continuo de gastos', action: 'modo_gastos' },
  { command: 'resumen', description: 'Resumen y balance de caja', action: 'consultar_resumen' },
  { command: 'movimientos', description: 'Últimos movimientos', action: 'consultar_movimientos' },
  { command: 'calcular', description: 'Calcular precio de venta', action: 'calcular_precio' },
  { command: 'deshacer', description: 'Anular último movimiento', action: 'deshacer_ultimo' },
];

export function createKioscoTemplate(deps: KioscoTemplateDeps): KioscoTemplateBundle {
  const cashRepo = new CashRepository(deps.db);
  const cash = new CashService(cashRepo);

  const template: TemplateDefinition = {
    id: 'kiosco',
    label: 'Kiosco',
    welcome: (businessName, firstName) =>
      [
        `👋 ¡Hola${firstName ? ` ${firstName}` : ''}! Soy el asistente financiero de *${businessName}*.`,
        '',
        '💵 *¿Cómo registrar operaciones?*',
        'Escribime o mandame un *audio* como le hablarías a una persona:',
        '• *"Vendí 5000"* o *"Venta 3200"*',
        '• *"Gasté 3500 en Coca"*',
        '• *"Pagué 12000 al proveedor"*',
        '• *"Compré 30 alfajores por 18000, quiero 40% de margen"*',
        '',
        '⚡ Para registrar ventas una tras otra sin parar, usá /ventas.',
        '📌 Abajo tenés botones rápidos, o tocá /menu para ver todo.',
      ].join('\n'),
    systemPrompt: (businessName, referenceDate, hints) =>
      buildKioscoSystemPrompt(businessName, referenceDate, hints),
    actions: buildKioscoActions({ cash }),
    commands: COMMANDS,
    replyMenu: [
      { label: '💰 Vender', action: 'registrar_venta' },
      { label: '💸 Gasto', action: 'registrar_gasto' },
      { label: '📊 Resumen', action: 'consultar_resumen' },
      { label: '🧮 Calcular', action: 'calcular_precio' },
    ],
    menu: [
      { label: '💰 Registrar venta', action: 'registrar_venta' },
      { label: '⚡ Modo continuo ventas', action: 'modo_ventas' },
      { label: '💸 Registrar gasto', action: 'registrar_gasto' },
      { label: '⚡ Modo continuo gastos', action: 'modo_gastos' },
      { label: '🧮 Calcular precio', action: 'calcular_precio' },
      { label: '📊 Resumen y balance', action: 'consultar_resumen' },
      { label: '📋 Últimos movimientos', action: 'consultar_movimientos' },
      { label: '↩️ Deshacer último', action: 'deshacer_ultimo' },
    ],
    menuCommands: [
      { command: 'venta', description: '💰 Registrar una venta' },
      { command: 'ventas', description: '⚡ Modo ventas continuo' },
      { command: 'gasto', description: '💸 Registrar un gasto' },
      { command: 'gastos', description: '⚡ Modo gastos continuo' },
      { command: 'resumen', description: '📊 Resumen de caja' },
      { command: 'movimientos', description: '📋 Últimos movimientos' },
      { command: 'calcular', description: '🧮 Calcular precio' },
      { command: 'deshacer', description: '↩️ Deshacer último' },
    ],
  };

  return {
    template,
    seedBusiness: async (_businessId: string) => {
      // Sin seeds: el asistente arranca listo para registrar movimientos.
    },
  };
}
