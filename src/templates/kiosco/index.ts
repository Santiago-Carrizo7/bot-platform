import type { PrismaClient } from '@prisma/client';
import type { CommandDef, TemplateDefinition } from '../../core/actions/registry.js';
import { CashRepository } from './persistence/cash.repo.js';
import { CashService } from './domain/cash.service.js';
import { buildKioscoActions, parseAmountAndNote, parseAmountsList } from './actions.js';
import { buildKioscoSystemPrompt } from './prompts.js';

export function interpretDirectlyKiosco(
  text: string,
  activeActionName?: string | null
): { actionName: string; params: Record<string, unknown> } | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Si estamos recolectando datos para una acción específica:
  if (activeActionName === 'registrar_venta') {
    const parsed = parseAmountAndNote(trimmed);
    if (parsed) return { actionName: 'registrar_venta', params: { monto: parsed.amount, nota: parsed.note } };
  }
  if (activeActionName === 'registrar_gasto') {
    const parsed = parseAmountAndNote(trimmed);
    if (parsed) return { actionName: 'registrar_gasto', params: { monto: parsed.amount, concepto: parsed.note || 'Gasto' } };
  }

  // Comandos de consulta frecuentes y estadísticas
  if (lower === 'estadisticas' || lower === 'estadísticas' || lower === 'menu estadisticas' || lower === 'menú estadísticas') {
    return { actionName: 'consultar_resumen', params: { periodo: 'menu' } };
  }
  if (lower === 'caja' || lower === 'caja hoy' || lower === 'balance' || lower === 'resumen' || lower === 'resumen hoy') {
    return { actionName: 'consultar_resumen', params: { periodo: 'hoy' } };
  }
  if (lower === 'resumen ayer' || lower === 'caja ayer') {
    return { actionName: 'consultar_resumen', params: { periodo: 'ayer' } };
  }
  if (lower === 'movimientos' || lower === 'ultimos movimientos' || lower === 'últimos movimientos') {
    return { actionName: 'consultar_movimientos', params: { limite: 10 } };
  }
  if (lower.includes('categoria') || lower.includes('categoría')) {
    return { actionName: 'consultar_resumen', params: { periodo: 'categorias' } };
  }

  // Patrones rápidos de gasto: "gaste 3500 en coca", "pague 12000 al proveedor", "gasto 1500"
  const gastoMatch = trimmed.match(/^(?:gast[eé]|pagu[eé]|gasto)\s+\$?([\d.,]+)(?:\s+(?:en\s+|a\s+|de\s+|al\s+)?(.*))?$/i);
  if (gastoMatch) {
    const num = parseAmountAndNote(gastoMatch[1]);
    if (num) {
      const concepto = (gastoMatch[2] || '').trim() || 'Gasto';
      return { actionName: 'registrar_gasto', params: { monto: num.amount, concepto } };
    }
  }

  // Patrones rápidos de venta: "vendi 5000", "venta 3200"
  const ventaPrefixMatch = trimmed.match(/^(?:vend[ií]|venta)\s+\$?([\d.,]+)(?:\s+(.*))?$/i);
  if (ventaPrefixMatch) {
    const num = parseAmountAndNote(ventaPrefixMatch[1]);
    if (num) {
      const nota = (ventaPrefixMatch[2] || '').trim() || undefined;
      return { actionName: 'registrar_venta', params: { monto: num.amount, nota } };
    }
  }

  // Múltiples ventas en un solo mensaje o audio (ej: "3200 2800 2500", "2000 y 3800", "hice dos ventas, una de 2000 y otra de 3800")
  const isExplicitExpense = /^(?:gast[eé]|pagu[eé]|compr[eé]|gastos?)\b/i.test(trimmed);
  if (!isExplicitExpense) {
    const multiAmounts = parseAmountsList(trimmed);
    if (multiAmounts && multiAmounts.length > 1) {
      return {
        actionName: 'registrar_venta',
        params: {
          ventas: multiAmounts.map((m) => ({
            monto: m.amount,
            nota: m.note,
          })),
        },
      };
    }
  }

  // Un número suelto o número con nota: "3000", "3000 alfajor", "$ 1500"
  const parsedDirect = parseAmountAndNote(trimmed);
  if (parsedDirect) {
    const noteLower = (parsedDirect.note || '').toLowerCase();
    const isExpense = ['proveedor', 'mayorista', 'luz', 'gas', 'internet', 'agua', 'alquiler', 'afip'].some((w) =>
      noteLower.includes(w)
    );
    if (isExpense) {
      return { actionName: 'registrar_gasto', params: { monto: parsedDirect.amount, concepto: parsedDirect.note || 'Gasto' } };
    }
    return { actionName: 'registrar_venta', params: { monto: parsedDirect.amount, nota: parsedDirect.note } };
  }

  return null;
}

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
  { command: 'resumen', description: 'Resumen y estadísticas de caja', action: 'consultar_resumen' },
  { command: 'estadisticas', description: 'Menú de estadísticas', action: 'consultar_resumen' },
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
    interpretDirectly: interpretDirectlyKiosco,
    actions: buildKioscoActions({ cash }),
    commands: COMMANDS,
    replyMenu: [
      { label: '💰 Vender', action: 'registrar_venta' },
      { label: '💸 Gasto', action: 'registrar_gasto' },
      { label: '📊 Estadísticas', action: 'consultar_resumen' },
      { label: '⚡ Modo rápido', action: 'modo_ventas' },
      { label: '🧮 Calcular', action: 'calcular_precio' },
      { label: '↩️ Deshacer', action: 'deshacer_ultimo' },
    ],
    menu: [
      { label: '💰 Registrar venta', action: 'registrar_venta' },
      { label: '⚡ Modo continuo ventas', action: 'modo_ventas' },
      { label: '💸 Registrar gasto', action: 'registrar_gasto' },
      { label: '⚡ Modo continuo gastos', action: 'modo_gastos' },
      { label: '📊 Estadísticas y resumen', action: 'consultar_resumen' },
      { label: '🧮 Calcular precio', action: 'calcular_precio' },
      { label: '📋 Últimos movimientos', action: 'consultar_movimientos' },
      { label: '↩️ Deshacer último', action: 'deshacer_ultimo' },
    ],
    menuCommands: [
      { command: 'venta', description: '💰 Registrar una venta' },
      { command: 'ventas', description: '⚡ Modo ventas continuo' },
      { command: 'gasto', description: '💸 Registrar un gasto' },
      { command: 'gastos', description: '⚡ Modo gastos continuo' },
      { command: 'estadisticas', description: '📊 Estadísticas y resumen' },
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
