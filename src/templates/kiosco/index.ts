import type { PrismaClient } from '@prisma/client';
import type {
  BotReply,
  CommandDef,
  InlineButton,
  TemplateDefinition,
} from '../../core/actions/registry.js';
import { CashRepository } from './persistence/cash.repo.js';
import { CashService } from './domain/cash.service.js';
import {
  buildKioscoActions,
  parseAmountAndNote,
  parseAmountsList,
  parseExpensesList,
  parseCalculatorDirectly,
  parseBatchItemCorrection,
} from './actions.js';
import { buildKioscoSystemPrompt } from './prompts.js';
import { formatCurrency } from './format.js';

export function interpretDirectlyKiosco(
  text: string,
  activeActionName?: string | null,
  activeData?: Record<string, unknown>
): { actionName: string; params: Record<string, unknown> } | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // 1. Si estamos en lote pendiente (confirmación o corrección interactiva):
  if (activeActionName === 'registrar_lote' && activeData && Array.isArray(activeData.items)) {
    const currentItems = [...(activeData.items as Array<any>)];

    // 1.A. Si el usuario estaba respondiendo el nuevo monto para un ítem específico (_editingItemIndex)
    if (typeof activeData._editingItemIndex === 'number') {
      const parsedNum = parseAmountAndNote(trimmed);
      if (parsedNum && parsedNum.amount > 0) {
        const idx = activeData._editingItemIndex;
        if (idx >= 0 && idx < currentItems.length) {
          currentItems[idx] = { ...currentItems[idx], monto: parsedNum.amount };
          const nextData: Record<string, unknown> = { ...activeData, items: currentItems };
          delete nextData._editingItemIndex;
          return { actionName: 'registrar_lote', params: nextData };
        }
      }
    }

    // 1.B. Corrección por lenguaje natural: "el 2 es 3300", "2 3300", "cambiar 3000 por 3300", "borrar 2"
    const patch = parseBatchItemCorrection(trimmed, currentItems);
    if (patch) {
      return { actionName: 'registrar_lote', params: { ...activeData, items: patch } };
    }
  }

  // 2. Si estamos recolectando datos en sesión continua:
  if (activeActionName === 'registrar_venta') {
    const multi = parseAmountsList(trimmed);
    if (multi && multi.length > 1) {
      return {
        actionName: 'registrar_lote',
        params: {
          items: multi.map((m) => ({ tipo: 'VENTA', monto: m.amount, nota: m.note })),
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
        actionName: 'registrar_lote',
        params: {
          items: multiGastos.map((g) => ({ tipo: 'GASTO', monto: g.amount, concepto: g.concepto })),
        },
      };
    }
    const parsed = parseAmountAndNote(trimmed);
    if (parsed) return { actionName: 'registrar_gasto', params: { monto: parsed.amount, concepto: parsed.note || 'Gasto' } };
  }

  // 3. Comandos de consulta frecuentes y estadísticas
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

  // 4. INTENCIÓN DE CALCULADORA DE PRECIOS (MÁXIMA PRIORIDAD ANTES QUE GASTOS O VENTAS)
  const isCalcIntent = /(?:a\s+cu[aá]nto|a\s+qu[eé]\s+precio|precio\s+(?:de\s+)?venta|para\s+ganar|margen|recargo|markup|calcular\s+precio)/i.test(
    trimmed
  );
  if (isCalcIntent) {
    const directCalc = parseCalculatorDirectly(trimmed);
    if (directCalc) {
      return directCalc;
    }
    return null;
  }

  // 5. DETECCIÓN DE MONTOS MÚLTIPLES (ANTES QUE NÚMERO ÚNICO)
  // 5.A. Gastos múltiples: "gasté 3000 en coca y 5000 en pan", "pagué 12000 al proveedor y 4500 de luz"
  const isExplicitExpense = /^(?:gast[eé]|pagu[eé]|compr[eé]|gastos?|pago)\b/i.test(trimmed);
  if (isExplicitExpense || trimmed.includes(' en ') || trimmed.includes(' al ') || trimmed.includes(' de ')) {
    const multiGastos = parseExpensesList(trimmed);
    if (multiGastos && multiGastos.length > 1) {
      return {
        actionName: 'registrar_lote',
        params: {
          items: multiGastos.map((g) => ({
            tipo: 'GASTO',
            monto: g.amount,
            concepto: g.concepto,
          })),
        },
      };
    }
  }

  // 5.B. Ventas múltiples: "vendí 5000 y vendí 12000", "vendí 3000 y 12000", "3200 2800 2500", "2000 y 3800"
  if (!isExplicitExpense) {
    const multiAmounts = parseAmountsList(trimmed);
    if (multiAmounts && multiAmounts.length > 1) {
      return {
        actionName: 'registrar_lote',
        params: {
          items: multiAmounts.map((m) => ({
            tipo: 'VENTA',
            monto: m.amount,
            nota: m.note,
          })),
        },
      };
    }
  }

  // 6. PATRONES DE MONTO INDIVIDUAL
  // 6.A. Gasto individual
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

  // 6.B. Venta individual
  const ventaPrefixMatch = trimmed.match(/^(?:vend[ií]|venta)\s+\$?([\d.,]+)(?:\s+(.*))?$/i);
  if (ventaPrefixMatch) {
    const num = parseAmountAndNote(ventaPrefixMatch[1]);
    if (num) {
      const nota = (ventaPrefixMatch[2] || '').trim() || undefined;
      return { actionName: 'registrar_venta', params: { monto: num.amount, nota } };
    }
  }

  // 6.C. Número suelto o con nota
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

export function createKioscoTemplateWithCash(cash: CashService): KioscoTemplateBundle {
  const template: TemplateDefinition = {
    id: 'kiosco',
    label: 'Kiosco',
    welcome: (businessName, firstName) =>
      [
        `👋 ¡Hola${firstName ? ` ${firstName}` : ''}! Administro la caja y finanzas de *${businessName}*.`,
        '',
        '• *💰 Ventas:* Ingresá los cobros del mostrador uno tras otro sin frenar.',
        '• *💸 Gastos:* Registrá compras a proveedores y servicios para controlar salidas.',
        '• *🧮 Calcular:* Calculadora de precios de venta sugeridos y márgenes.',
        '• *📊 Estadísticas:* Balance de caja de hoy, ayer, semana o mes.',
        '• *↩️ Deshacer última acción:* Anulá el último movimiento si hubo un error.',
        '',
        '🎙️ *Audios:* Podés dictarme ventas o gastos como a un empleado. Te sugerimos mandar audios de menos de 1 minuto para que la respuesta sea instantánea.',
        '',
        '📌 Abajo tenés los botones directos, o tocá /menu para ver todo.',
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
    handleCallback: async (ctx, data, activeState, conversations) => {
      const registrarLoteAction = template.actions.find((a) => a.name === 'registrar_lote');

      // 1. Selector interactivo para corregir monto de un ítem
      if (data === 'kiosco:correct_prompt') {
        const currentData = (activeState?.data ?? {}) as Record<string, unknown>;
        const items = Array.isArray(currentData.items) ? (currentData.items as Array<any>) : [];
        if (items.length === 0) return { text: 'No hay ítems para corregir.', parseMode: 'Markdown' };

        const itemButtons: InlineButton[][] = [];
        for (let i = 0; i < items.length; i += 2) {
          const row: InlineButton[] = [];
          row.push({
            text: `${i + 1}️⃣ ${formatCurrency(items[i].monto)}`,
            callbackData: `kiosco:edit_item:${i}`,
          });
          if (i + 1 < items.length) {
            row.push({
              text: `${i + 2}️⃣ ${formatCurrency(items[i + 1].monto)}`,
              callbackData: `kiosco:edit_item:${i + 1}`,
            });
          }
          itemButtons.push(row);
        }
        itemButtons.push([{ text: '⬅️ Volver', callbackData: 'kiosco:show_summary' }]);

        return {
          text: '✏️ *Elegí qué monto querés corregir:*',
          parseMode: 'Markdown',
          inlineKeyboard: itemButtons,
        };
      }

      // 2. Selección de un ítem para editar
      if (data.startsWith('kiosco:edit_item:')) {
        const idx = parseInt(data.slice('kiosco:edit_item:'.length), 10);
        const currentData = (activeState?.data ?? {}) as Record<string, unknown>;
        const items = Array.isArray(currentData.items) ? (currentData.items as Array<any>) : [];
        const item = items[idx];
        if (!item) return { text: 'Ítem no encontrado.', parseMode: 'Markdown' };

        if (conversations && activeState) {
          await conversations.upsert({
            ...activeState,
            data: {
              ...currentData,
              _editingItemIndex: idx,
            },
            updatedAt: ctx.now,
          });
        }

        return {
          text: `✏️ *Ingresá el nuevo importe para el ítem ${idx + 1} (actual: ${formatCurrency(item.monto)}):*\n\nPodés escribir el número o mandar un audio (ej: *3300*).`,
          parseMode: 'Markdown',
          inlineKeyboard: [
            [
              { text: '🗑️ Borrar este ítem', callbackData: `kiosco:del_item:${idx}` },
              { text: '⬅️ Volver', callbackData: 'kiosco:show_summary' },
            ],
          ],
        };
      }

      // 3. Borrar ítem
      if (data.startsWith('kiosco:del_item:')) {
        const idx = parseInt(data.slice('kiosco:del_item:'.length), 10);
        const currentData = (activeState?.data ?? {}) as Record<string, unknown>;
        const items = Array.isArray(currentData.items) ? [...(currentData.items as Array<any>)] : [];
        if (idx >= 0 && idx < items.length) {
          items.splice(idx, 1);
        }
        if (items.length === 0) {
          if (conversations) await conversations.clear(ctx.tenant.business.id, ctx.actorUserId);
          return { text: '🗑️ Se borraron todos los ítems. Lote cancelado.', parseMode: 'Markdown' };
        }
        delete currentData._editingItemIndex;
        currentData.items = items;
        if (conversations && activeState) {
          await conversations.upsert({
            ...activeState,
            data: currentData,
            updatedAt: ctx.now,
          });
        }
        const summary = registrarLoteAction?.summarize
          ? await registrarLoteAction.summarize(currentData as any, ctx)
          : 'Lote actualizado.';
        const buttons = registrarLoteAction?.confirmButtons ? registrarLoteAction.confirmButtons(currentData as any) : undefined;
        return {
          text: summary,
          parseMode: 'Markdown',
          inlineKeyboard: buttons,
        };
      }

      // 4. Volver a mostrar resumen
      if (data === 'kiosco:show_summary') {
        const currentData = (activeState?.data ?? {}) as Record<string, unknown>;
        delete currentData._editingItemIndex;
        if (conversations && activeState) {
          await conversations.upsert({ ...activeState, data: currentData, updatedAt: ctx.now });
        }
        const summary = registrarLoteAction?.summarize
          ? await registrarLoteAction.summarize(currentData as any, ctx)
          : 'Lote actualizado.';
        const buttons = registrarLoteAction?.confirmButtons ? registrarLoteAction.confirmButtons(currentData as any) : undefined;
        return {
          text: summary,
          parseMode: 'Markdown',
          inlineKeyboard: buttons,
        };
      }

      return null;
    },
  };

  return {
    template,
    seedBusiness: async (_businessId: string) => {
      // Sin seeds: el asistente arranca listo para registrar movimientos.
    },
  };
}

export function createKioscoTemplate(deps: KioscoTemplateDeps): KioscoTemplateBundle {
  const cashRepo = new CashRepository(deps.db);
  const cash = new CashService(cashRepo);
  return createKioscoTemplateWithCash(cash);
}
