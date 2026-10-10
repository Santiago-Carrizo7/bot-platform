import type { PrismaClient } from '@prisma/client';
import type { CommandDef, TemplateDefinition } from '../../core/actions/registry.js';
import { CashRepository } from './persistence/cash.repo.js';
import { CashService } from './domain/cash.service.js';
import {
  buildKioscoActions,
  parseAmountAndNote,
  parseAmountsList,
  parseExpensesList,
  parseCalculatorDirectly,
} from './actions.js';
import { buildKioscoSystemPrompt } from './prompts.js';

export function interpretDirectlyKiosco(
  text: string,
  activeActionName?: string | null
): { actionName: string; params: Record<string, unknown> } | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // 1. Si estamos recolectando datos para una acción específica:
  if (activeActionName === 'registrar_venta') {
    const multi = parseAmountsList(trimmed);
    if (multi && multi.length > 1) {
      return {
        actionName: 'registrar_venta',
        params: {
          ventas: multi.map((m) => ({ monto: m.amount, nota: m.note })),
        },
      };
    }
    const parsed = parseAmountAndNote(trimmed);
    if (parsed) return { actionName: 'registrar_venta', params: { monto: parsed.amount, nota: parsed.note } };
  }
  if (activeActionName === 'registrar_gasto') {
    const multiGastos = parseExpensesList(trimmed);
    if (multiGastos && multiGastos.length > 1) {
      return {
        actionName: 'registrar_gasto',
        params: {
          gastos: multiGastos.map((g) => ({ monto: g.amount, concepto: g.concepto })),
        },
      };
    }
    const parsed = parseAmountAndNote(trimmed);
    if (parsed) return { actionName: 'registrar_gasto', params: { monto: parsed.amount, concepto: parsed.note || 'Gasto' } };
  }

  // 2. Comandos de consulta frecuentes y estadísticas
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

  // 3. INTENCIÓN DE CALCULADORA DE PRECIOS (MÁXIMA PRIORIDAD ANTES QUE GASTOS O VENTAS)
  // Si pregunta a cuánto vender, margen, recargo o calcular ganancia, NUNCA debe ser gasto ni venta.
  const isCalcIntent = /(?:a\s+cu[aá]nto|a\s+qu[eé]\s+precio|precio\s+(?:de\s+)?venta|para\s+ganar|margen|recargo|markup|calcular\s+precio)/i.test(
    trimmed
  );
  if (isCalcIntent) {
    const directCalc = parseCalculatorDirectly(trimmed);
    if (directCalc) {
      return directCalc;
    }
    // Si hay intención clara de calculadora pero no se pudieron extraer determinísticamente los datos,
    // NUNCA caer en las regex de gasto o venta: devolvemos null para que vaya a la IA (con el system prompt reforzado).
    return null;
  }

  // 4. DETECCIÓN DE MONTOS MÚLTIPLES (ANTES QUE NÚMERO ÚNICO)
  // 4.A. Gastos múltiples: "gasté 3000 en coca y 5000 en pan", "pagué 12000 al proveedor y 4500 de luz"
  const isExplicitExpense = /^(?:gast[eé]|pagu[eé]|compr[eé]|gastos?|pago)\b/i.test(trimmed);
  if (isExplicitExpense || trimmed.includes(' en ') || trimmed.includes(' al ') || trimmed.includes(' de ')) {
    const multiGastos = parseExpensesList(trimmed);
    if (multiGastos && multiGastos.length > 1) {
      return {
        actionName: 'registrar_gasto',
        params: {
          gastos: multiGastos.map((g) => ({
            monto: g.amount,
            concepto: g.concepto,
          })),
        },
      };
    }
  }

  // 4.B. Ventas múltiples: "vendí 5000 y vendí 12000", "vendí 3000 y 12000", "3200 2800 2500", "2000 y 3800"
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

  // 5. PATRONES DE MONTO INDIVIDUAL (DESPUÉS DE DESCARTAR MÚLTIPLES)
  // 5.A. Gasto individual: "gasté 3500 en coca", "pagué 12000 al proveedor", "gasto 1500"
  const gastoMatch = trimmed.match(
    /^(?:gast[eé]|pagu[eé]|gasto)\s+\$?([\d.,]+)(?:\s+(?:en\s+|a\s+|de\s+|al\s+)?(.*))?$/i
  );
  if (gastoMatch) {
    const num = parseAmountAndNote(gastoMatch[1]);
    if (num) {
      const concepto = (gastoMatch[2] || '').trim() || 'Gasto';
      return { actionName: 'registrar_gasto', params: { monto: num.amount, concepto } };
    }
  }

  // 5.B. Venta individual: "vendí 5000", "venta 3200"
  const ventaPrefixMatch = trimmed.match(/^(?:vend[ií]|venta)\s+\$?([\d.,]+)(?:\s+(.*))?$/i);
  if (ventaPrefixMatch) {
    const num = parseAmountAndNote(ventaPrefixMatch[1]);
    if (num) {
      const nota = (ventaPrefixMatch[2] || '').trim() || undefined;
      return { actionName: 'registrar_venta', params: { monto: num.amount, nota } };
    }
  }

  // 5.C. Número suelto o con nota: "3000", "3000 alfajor", "$ 1500", "1500 luz"
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
  { command: 'ventas', description: 'Registrar ventas', action: 'registrar_venta' },
  { command: 'venta', description: 'Registrar una venta', action: 'registrar_venta' },
  { command: 'gastos', description: 'Registrar gastos', action: 'registrar_gasto' },
  { command: 'gasto', description: 'Registrar un gasto', action: 'registrar_gasto' },
  { command: 'resumen', description: 'Resumen y estadísticas de caja', action: 'consultar_resumen' },
  { command: 'estadisticas', description: 'Menú de estadísticas', action: 'consultar_resumen' },
  { command: 'movimientos', description: 'Últimos movimientos', action: 'consultar_movimientos' },
  { command: 'calcular', description: 'Calcular precio de venta', action: 'calcular_precio' },
  { command: 'deshacer', description: 'Deshacer última acción', action: 'deshacer_ultimo' },
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
        '• *"Vendí 5000"* o *"3200"*',
        '• *"Vendí 2000 y 3800"*',
        '• *"Gasté 3500 en Coca"*',
        '• *"Gasté 3000 en coca y 5000 en pan"*',
        '• *"Pagué 12000 al proveedor"*',
        '• *"Compré 30 alfajores por 18000 a cuánto los vendo"*',
        '',
        '📌 Abajo tenés botones rápidos, o tocá /menu para ver todo.',
      ].join('\n'),
    systemPrompt: (businessName, referenceDate, hints) =>
      buildKioscoSystemPrompt(businessName, referenceDate, hints),
    interpretDirectly: interpretDirectlyKiosco,
    actions: buildKioscoActions({ cash }),
    commands: COMMANDS,
    replyMenu: [
      { label: '💰 Ventas', action: 'registrar_venta' },
      { label: '💸 Gastos', action: 'registrar_gasto' },
      { label: '📊 Estadísticas', action: 'consultar_resumen' },
      { label: '🧮 Calcular', action: 'calcular_precio' },
      { label: '↩️ Deshacer última acción', action: 'deshacer_ultimo' },
    ],
    replyMenuLayout: [2, 2, 1],
    menu: [
      { label: '💰 Registrar ventas', action: 'registrar_venta' },
      { label: '💸 Registrar gastos', action: 'registrar_gasto' },
      { label: '📊 Estadísticas y resumen', action: 'consultar_resumen' },
      { label: '🧮 Calcular precio', action: 'calcular_precio' },
      { label: '📋 Últimos movimientos', action: 'consultar_movimientos' },
      { label: '↩️ Deshacer última acción', action: 'deshacer_ultimo' },
    ],
    menuCommands: [
      { command: 'ventas', description: '💰 Registrar ventas' },
      { command: 'gastos', description: '💸 Registrar gastos' },
      { command: 'estadisticas', description: '📊 Estadísticas y resumen' },
      { command: 'resumen', description: '📊 Resumen de caja' },
      { command: 'movimientos', description: '📋 Últimos movimientos' },
      { command: 'calcular', description: '🧮 Calcular precio' },
      { command: 'deshacer', description: '↩️ Deshacer última acción' },
    ],
  };

  return {
    template,
    seedBusiness: async (_businessId: string) => {
      // Sin seeds: el asistente arranca listo para registrar movimientos.
    },
  };
}
