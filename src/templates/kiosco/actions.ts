import type { ActionDef, ActionContext } from '../../core/actions/registry.js';
import { CashService, getZonedParts, zonedDateToUtc } from './domain/cash.service.js';
import {
  CalcularPrecioInput,
  ConsultarMovimientosInput,
  ConsultarResumenInput,
  EmptyInput,
  RegistrarGastoInput,
  RegistrarVentaInput,
  RegistrarLoteInput,
  type CalcularPrecioInput as CalcularPrecio,
  type ConsultarMovimientosInput as ConsultarMovimientos,
  type ConsultarResumenInput as ConsultarResumen,
  type EmptyInput as Empty,
  type RegistrarGastoInput as RegistrarGasto,
  type RegistrarVentaInput as RegistrarVenta,
  type RegistrarLoteInput as RegistrarLote,
} from './schemas.js';
import { esc, formatCurrency, formatDateTime, formatExpenseConcept, formatExpenseLines } from './format.js';
import type { PeriodSummary } from './types.js';

export interface KioscoActionDeps {
  cash: CashService;
}

export function sanitizeSpeech(text: string): string {
  return text
    .replace(/\.{2,}/g, ' ')
    .replace(/,\s*,+/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parsea un texto con monto y concepto/nota opcional para el modo continuo. */
export function parseAmountAndNote(raw: string): { amount: number; note?: string } | null {
  const sanitized = sanitizeSpeech(raw);
  const match = sanitized.match(/^\$?\s*([\d.,]+)\s*(mil|lucas?|[kK])?(?:\s+pesos)?(?:\s+(.*))?$/i);
  if (!match) return null;
  const numStr = match[1];
  const unit = match[2]?.toLowerCase();
  let note = match[3]?.trim() || undefined;

  let clean = numStr;
  if (clean.includes('.') && clean.includes(',')) {
    // Ej: 1.200.000,50 o 1,200,000.50
    const lastDot = clean.lastIndexOf('.');
    const lastComma = clean.lastIndexOf(',');
    if (lastComma > lastDot) {
      // Formato argentino: 1.200.000,50
      clean = clean.replace(/\./g, '').replace(',', '.');
    } else {
      // Formato anglosajón: 1,200,000.50
      clean = clean.replace(/,/g, '');
    }
  } else if (clean.includes(',')) {
    // Si tiene comas como separador de miles: 1,200,000 o 150,000
    if (/^\d{1,3}(?:,\d{3})+$/.test(clean)) {
      clean = clean.replace(/,/g, '');
    } else {
      clean = clean.replace(',', '.');
    }
  } else if (clean.includes('.')) {
    // Si tiene puntos como separador de miles: 1.200.000 o 150.000
    if (/^\d{1,3}(?:\.\d{3})+$/.test(clean)) {
      clean = clean.replace(/\./g, '');
    } else {
      const parts = clean.split('.');
      if (parts.length === 2 && parts[1].length === 3) {
        clean = parts[0] + parts[1];
      }
    }
  }

  let amount = parseFloat(clean);
  if (isNaN(amount) || amount <= 0) return null;

  if (unit === 'mil' || unit === 'k' || unit === 'luca' || unit === 'lucas') {
    if (amount < 1000) {
      amount = Math.round(amount * 1000);
    }
  }

  if (note) {
    note = note.replace(/^(?:pesos|en|de|a|al|por)\s+/i, '').trim();
    note = note.replace(/^(?:en|de|a|al|por)\s+/i, '').trim();
    if (!note) note = undefined;
  }

  return { amount: Math.round(amount * 100) / 100, note };
}

/**
 * Parsea un ítem individual dentro de una lista de montos (ej: "2000", "una de 2.000", "otra de 3.800 puchos", "vendí 8000 pesos en coca").
 */
function parseListItem(part: string): { amount: number; note?: string } | null {
  const sanitized = sanitizeSpeech(part);
  if (!sanitized) return null;

  // Si ya es un número directo (con o sin nota)
  const direct = parseAmountAndNote(sanitized);
  if (direct) return direct;

  // Limpiar prefijos comunes de lenguaje natural en audios o texto:
  // "una de 2.000", "otra de 3.800", "venta de 1500", "primera de 2000", "otra de 3500 puchos", "vendí 8000 pesos en coca"
  const match = sanitized.match(
    /^(?:(?:hice|hubo|registré|tuvimos|vendí|vendi|cobré|cobre)\s+)?(?:(?:una|otra|un|otro|primera|segunda|tercera)\s+)?(?:ventas?|operaci[oó]n)?\s*(?:de\s+|por\s+)?(.*)$/i
  );
  if (match && match[1]) {
    const parsed = parseAmountAndNote(match[1]);
    if (parsed) return parsed;
  }

  return null;
}

/**
 * Parsea múltiples ventas de un texto o transcripción de audio (ej: "3200, 2800, 2500", "2000 y 3800", "vendí 5000 y vendí 12000", "vendí 8000 pesos en Coca Cola, 15000 en papa y 30000 en gaseosa").
 */
export function parseAmountsList(raw: string): Array<{ amount: number; note?: string }> | null {
  const sanitized = sanitizeSpeech(raw);

  // Si contiene modismos complejos o frases largas con palabras de jerga, dejar al LLM
  if (
    /(?:palo|mill[oó]n|millones|sueldo|empleado)/i.test(sanitized) ||
    sanitized.split(/\s+/).length > 30
  ) {
    return null;
  }

  // Caso A: Separados por comas, saltos de línea o "y"
  if (sanitized.includes(',') || sanitized.includes('\n') || /\s+y\s+/i.test(sanitized)) {
    const parts = sanitized
      .split(/[\n]|(?:\s+y\s+)|(?:,(?!\d{3}\b))/i)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 1) {
      const items: Array<{ amount: number; note?: string }> = [];
      for (const part of parts) {
        const parsed = parseListItem(part);
        if (parsed) {
          items.push(parsed);
        }
      }
      if (items.length > 1) return items;
    }
  }

  // Caso B: Ráfaga de números separados solo por espacios (ej: "3200 2800 2500 8000")
  const tokens = sanitized.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    const numbers: Array<{ amount: number; note?: string }> = [];
    let allNumbers = true;
    for (const tok of tokens) {
      const parsed = parseAmountAndNote(tok);
      if (parsed && !parsed.note) {
        numbers.push(parsed);
      } else {
        allNumbers = false;
        break;
      }
    }
    if (allNumbers && numbers.length > 1) {
      return numbers;
    }
  }

  return null;
}

/**
 * Parsea múltiples gastos de un texto (ej: "gasté 3000 en coca y 5000 en pan", "pagué 12000 al proveedor y 4500 de luz").
 */
export function parseExpensesList(raw: string): Array<{ amount: number; concepto: string }> | null {
  const sanitized = sanitizeSpeech(raw);
  // Si contiene modismos complejos o frases largas con verbos o millones, dejarlo al LLM
  if (
    /(?:palo|mill[oó]n|millones|sueldo|empleado)/i.test(sanitized) ||
    sanitized.split(/\s+/).length > 30
  ) {
    return null;
  }

  if (!sanitized.includes(',') && !sanitized.includes('\n') && !/\s+y\s+/i.test(sanitized)) {
    return null;
  }

  // Dividir por saltos de línea, 'y' o comas que NO sean separadores numéricos (ej: no dividir '1,200,000')
  const parts = sanitized
    .split(/[\n]|(?:\s+y\s+)|(?:,(?!\d{3}\b))/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const items: Array<{ amount: number; concepto: string }> = [];
  for (const part of parts) {
    // Quitar verbos iniciales de gasto: "gasté", "pagué", "gasto", "compré", etc.
    const cleaned = part
      .replace(
        /^(?:(?:gast[eé]|pagu[eé]|compr[eé]|gasto|pago)\s+)?(?:(?:un|otro|primer|segundo)\s+)?(?:gastos?|pago)?\s*(?:de\s+|por\s+)?/i,
        ''
      )
      .trim();

    // 1. Caso monto primero: "3000 en coca", "3000 coca", "$5000 pan", "12000 al proveedor", "8 mil en coca"
    const parsedNum = parseAmountAndNote(cleaned);
    if (parsedNum && parsedNum.amount > 0) {
      let concepto = parsedNum.note?.trim() || '';
      concepto = concepto.replace(/^(?:en|de|al|a|por)\s+/i, '').trim();
      if (concepto) {
        items.push({ amount: parsedNum.amount, concepto });
        continue;
      }
    }

    // 2. Caso concepto primero o frase: "coca 3000", "coca por 3000", "proveedor 12000"
    const matchInverted = cleaned.match(/^(.*?)\s+(?:por|a|en)?\s*\$?([\d.,]+)(?:\s*(mil|lucas?|[kK])\b)?$/i);
    if (matchInverted) {
      const numExpr = matchInverted[2] + (matchInverted[3] ? ` ${matchInverted[3]}` : '');
      const num = parseAmountAndNote(numExpr);
      let concepto = matchInverted[1].trim();
      concepto = concepto.replace(/^(?:en|de|al|a|por)\s+/i, '').trim();
      if (num && num.amount > 0 && concepto) {
        items.push({ amount: num.amount, concepto });
        continue;
      }
    }
  }

  if (items.length >= 2) {
    return items;
  }
  return null;
}

/**
 * Atajo determinístico 0ms para la calculadora de precios.
 * Extrae costo (unitario o lote con cantidad), porcentaje y tipo si están presentes.
 */
export function parseCalculatorDirectly(trimmed: string): {
  actionName: 'calcular_precio';
  params: Record<string, unknown>;
} | null {
  const isCalc = /(?:a\s+cu[aá]nto|a\s+qu[eé]\s+precio|precio\s+(?:de\s+)?venta|para\s+ganar|margen|recargo|markup|calcular\s+precio)/i.test(
    trimmed
  );
  if (!isCalc) return null;

  // Extraer porcentaje si existe
  let porcentaje: number | undefined;
  const pctMatch =
    trimmed.match(/(?:ganar|margen|recargo|markup|con)?\s*(\d+(?:[.,]\d+)?)\s*(?:%|por\s*ciento)/i) ||
    trimmed.match(/(?:para\s+ganar\s+)(\d+(?:[.,]\d+)?)/i);
  if (pctMatch) {
    porcentaje = parseFloat(pctMatch[1].replace(',', '.'));
  }

  // Extraer tipo si existe
  let tipo: 'margen' | 'recargo' | undefined;
  if (/\bmargen\b/i.test(trimmed)) tipo = 'margen';
  else if (/\b(?:recargo|markup)\b/i.test(trimmed)) tipo = 'recargo';

  // Extraer cantidad y costos
  let cantidad: number | undefined;
  let costo_total: number | undefined;
  let costo_unitario: number | undefined;

  // Patrón lote: "30 alfajores por 18000", "pack de 12 hierbas por 30000", "12 unidades a 24000"
  const packMatch = trimmed.match(
    /(?:compr[eé]|gast[eé]|pagu[eé])?\s*(?:un\s+pack\s+de\s+|un\s+bulto\s+de\s+|caja\s+de\s+)?(\d+)\s+([a-záéíóúñ\s]+?)\s+(?:por|a|en)\s+\$?([\d.,]+)/i
  );
  if (packMatch) {
    const q = parseInt(packMatch[1], 10);
    const num = parseAmountAndNote(packMatch[3]);
    if (q > 0 && num && num.amount > 0) {
      cantidad = q;
      costo_total = num.amount;
    }
  }

  // Patrón "gasté 30.000 en comprar un pack de 12 hierbas" o "gasté 30000 en 12 alfajores"
  if (!costo_total) {
    const altPack = trimmed.match(
      /(?:gast[eé]|pagu[eé]|compr[eé])\s+\$?([\d.,]+)\s+(?:en\s+|para\s+)?(?:comprar\s+)?(?:un\s+pack\s+de\s+|una\s+caja\s+de\s+)?(\d+)/i
    );
    if (altPack) {
      const num = parseAmountAndNote(altPack[1]);
      const q = parseInt(altPack[2], 10);
      if (q > 0 && num && num.amount > 0) {
        costo_total = num.amount;
        cantidad = q;
      }
    }
  }

  // Patrón costo unitario: "costo 600", "costo unitario 500"
  if (!costo_total && !costo_unitario) {
    const unitMatch = trimmed.match(/(?:costo\s+(?:unitario\s+)?|sali[oó]\s+|pag[eé]\s+)\$?([\d.,]+)/i);
    if (unitMatch) {
      const num = parseAmountAndNote(unitMatch[1]);
      if (num && num.amount > 0) {
        costo_unitario = num.amount;
      }
    }
  }

  // Extraer cantidad suelta si existe: "30 alfajores", "30 unidades"
  if (!cantidad) {
    const qtyMatch = trimmed.match(/(?:cantidad|cant\.?|pack\s+de|caja\s+de)?\s*(\d+)\s*(?:unidades|u\b|alfajores|chocolates|paquetes|art[ií]culos)/i);
    if (qtyMatch) {
      const q = parseInt(qtyMatch[1], 10);
      if (q > 0) cantidad = q;
    }
  }

  const hasCost =
    costo_unitario !== undefined ||
    (costo_total !== undefined && cantidad !== undefined) ||
    costo_total !== undefined;

  if (hasCost) {
    const params: Record<string, unknown> = {};
    if (costo_total !== undefined) params.costo_total = costo_total;
    if (cantidad !== undefined) params.cantidad = cantidad;
    if (costo_unitario !== undefined) params.costo_unitario = costo_unitario;
    if (porcentaje !== undefined) params.porcentaje = porcentaje;
    if (tipo !== undefined) params.tipo = tipo;
    return { actionName: 'calcular_precio', params };
  }

  return null;
}

/**
 * Parsea una corrección de un ítem en lenguaje natural para un lote pendiente:
 * - "el 2 es 3300", "el 2 era 3300", "2 3300", "2 es 3300", "ítem 2 3300", "2 = 3300"
 * - "cambiar 3000 por 3300", "3000 no, 3300"
 * - "borrar 2", "eliminar 2", "sacar 2"
 */
export function parseBatchItemCorrection<T extends { monto: number }>(
  raw: string,
  items: T[]
): T[] | null {
  const trimmed = raw.trim();

  // 0. Caso especial cuando hay un solo ítem en el lote:
  if (items.length === 1) {
    if (/^(?:borrar|eliminar|sacar|quitar|cancelar)$/i.test(trimmed)) {
      return [];
    }
    const singleMatch = trimmed.match(
      /^(?:cambiar\s+(?:a|por)?\s*)?(?:no,?\s+)?(?:es|era|=|a|por|de|son)?\s*\$?([\d.,]+)(?:\s+(mil|lucas?|[kK])\b)?$/i
    );
    if (singleMatch) {
      const fullExpr = singleMatch[1] + (singleMatch[2] ? ` ${singleMatch[2]}` : '');
      const parsed = parseAmountAndNote(fullExpr);
      if (parsed && parsed.amount > 0) {
        const copy = [...items];
        copy[0] = { ...copy[0], monto: parsed.amount };
        return copy;
      }
    }
  }

  // 1. Borrar ítem: "borrar 2", "eliminar 2", "sacar 2", "quitar el 2"
  const delMatch = trimmed.match(/^(?:borrar|eliminar|sacar|quitar)\s+(?:el\s+|[ií]tem\s+)?(\d+)$/i);
  if (delMatch) {
    const idx = parseInt(delMatch[1], 10) - 1;
    if (idx >= 0 && idx < items.length) {
      const copy = [...items];
      copy.splice(idx, 1);
      return copy.length > 0 ? copy : null;
    }
  }

  // 2. Modificar por número de orden: "el 2 es 3300", "el 2 era 3300", "2 3300", "2 es 3300", "ítem 2 = 3300", "cambiar el 2 a 3300"
  const editMatch = trimmed.match(
    /^(?:cambiar\s+)?(?:el\s+|[ií]tem\s+)?(\d+)\s*(?:es|era|=|a|por|de|\s)\s*\$?([\d.,]+)$/i
  );
  if (editMatch) {
    const idx = parseInt(editMatch[1], 10) - 1;
    const parsed = parseAmountAndNote(editMatch[2]);
    if (idx >= 0 && idx < items.length && parsed && parsed.amount > 0) {
      const copy = [...items];
      copy[idx] = { ...copy[idx], monto: parsed.amount };
      return copy;
    }
  }

  // 3. Modificar por reemplazo de valor: "cambiar 3000 por 3300", "cambiar 3000 a 3300", "3000 no, 3300"
  const replaceMatch = trimmed.match(
    /(?:cambiar\s+)?\$?([\d.,]+)\s*(?:por|a|no,\s*)\s*\$?([\d.,]+)/i
  );
  if (replaceMatch) {
    const oldVal = parseAmountAndNote(replaceMatch[1]);
    const newVal = parseAmountAndNote(replaceMatch[2]);
    if (oldVal && newVal && newVal.amount > 0) {
      const idx = items.findIndex((it) => it.monto === oldVal.amount);
      if (idx !== -1) {
        const copy = [...items];
        copy[idx] = { ...copy[idx], monto: newVal.amount };
        return copy;
      }
    }
  }

  return null;
}

export function buildKioscoActions(deps: KioscoActionDeps): ActionDef<unknown>[] {
  const { cash } = deps;

  const registrarVenta: ActionDef<any> = {
    name: 'registrar_venta',
    description:
      'Registra cobros y ventas de dinero en el mostrador. Permite ingresar importes de forma ágil y continua.',
    kind: 'read',
    input: RegistrarVentaInput,
    isContinuous: true,
    handler: async (ctx, initialData) => {
      const data = (initialData ?? {}) as Record<string, unknown>;
      if (data.monto) {
        const amount = Number(data.monto);
        const note = data.nota ? String(data.nota) : undefined;
        const movement = await cash.recordSale(ctx.tenant.business.id, ctx.actorUserId, {
          monto: amount,
          nota: note,
          fecha: ctx.now,
        });
        return {
          reply: [
            `🟢 Venta registrada: *${formatCurrency(amount)}*${note ? ` (${esc(note)})` : ''}`,
            `_Total acumulado: ${formatCurrency(amount)} (1)_`,
            '',
            'Podés seguir enviando números para sumar a esta tanda o tocar Finalizar.',
          ].join('\n'),
          inlineKeyboard: [
            [{ text: '↩️ Deshacer última venta', callbackData: 'undo:ask' }, { text: '🏁 Finalizar', callbackData: 'continuous:fin' }],
          ],
          audit: {
            action: 'sale.recorded',
            entityType: 'money_movement',
            entityId: movement.id,
            metadata: { amount, note },
          },
        };
      }

      return {
        reply: [
          '🟢 *Registro de ventas*',
          'Escribí los números que vayas cobrando y los registro al momento (ej: *2500* o *3000 y 4500*).',
          '',
          '💡 _Tip: Para audios, te sugerimos que duren menos de 1 minuto para que la transcripción sea instantánea._',
          '',
          'Podés finalizar o deshacer con los botones abajo cuando quieras.',
        ].join('\n'),
        inlineKeyboard: [
          [{ text: '🏁 Finalizar', callbackData: 'continuous:fin' }, { text: '❌ Cancelar', callbackData: 'continuous:cancel' }],
        ],
      };
    },
    handleContinuousStep: async (ctx, text, data) => {
      const lower = text.trim().toLowerCase();
      if (lower === '/fin' || lower === 'fin' || lower === 'finalizar') {
        const count = Number(data.count ?? 0);
        const total = Number(data.total ?? 0);
        return {
          reply: {
            text: [
              '🏁 *Registro de ventas finalizado*',
              '',
              `• Ventas registradas: *${count}*`,
              `• Total acumulado: *${formatCurrency(total)}*`,
            ].join('\n'),
            parseMode: 'Markdown',
          },
          finished: true,
        };
      }

      if (lower === '/deshacer' || lower === 'deshacer') {
        const undone = await cash.undoLast(ctx.tenant.business.id, ctx.actorUserId);
        if (!undone) {
          return {
            reply: { text: 'No hay ventas recientes para anular.', parseMode: 'Markdown' },
          };
        }
        const undoneAmount = Number(undone.amount);
        const count = Math.max(0, Number(data.count ?? 1) - 1);
        const total = Math.max(0, Number(data.total ?? undoneAmount) - undoneAmount);
        return {
          reply: {
            text: `↩️ Se anuló la última venta de *${formatCurrency(undoneAmount)}*.\n_Total acumulado: ${formatCurrency(total)} (${count})_`,
            parseMode: 'Markdown',
            inlineKeyboard: count > 0
              ? [
                  [{ text: '↩️ Deshacer última venta', callbackData: 'undo:ask' }, { text: '🏁 Finalizar', callbackData: 'continuous:fin' }],
                ]
              : [
                  [{ text: '🏁 Finalizar', callbackData: 'continuous:fin' }],
                ],
          },
          updatedData: { ...data, count, total },
        };
      }

      // 1. Detectar si envió audio o texto con lista/ráfaga de números (ej. "3200 2800 2500" o "12000, 3000 y 8000")
      const multiple = parseAmountsList(text);
      if (multiple && (multiple.length > 1 || (ctx.isVoice && multiple.length > 0))) {
        return {
          reply: { text: 'Entendido. Preparando confirmación...' },
          switchToConfirming: {
            actionName: 'registrar_lote',
            data: {
              origen: ctx.isVoice ? 'audio' : 'texto',
              items: multiple.map((m) => ({
                tipo: 'VENTA',
                monto: m.amount,
                nota: m.note,
              })),
            },
          },
        };
      }

      // 2. Venta individual (ej. "2500", "2500 puchos")
      const parsed = parseAmountAndNote(text);
      if (!parsed) {
        return {
          reply: {
            text: '⚠️ Mandá el importe (ej. *2500* o *3200 y 1500*), o tocá *🏁 Finalizar*.',
            parseMode: 'Markdown',
            inlineKeyboard: [
              [{ text: '🏁 Finalizar', callbackData: 'continuous:fin' }, { text: '❌ Cancelar', callbackData: 'continuous:cancel' }],
            ],
          },
        };
      }

      if (ctx.isVoice) {
        return {
          reply: { text: 'Entendido. Preparando confirmación...' },
          switchToConfirming: {
            actionName: 'registrar_lote',
            data: {
              origen: 'audio',
              items: [{
                tipo: 'VENTA',
                monto: parsed.amount,
                nota: parsed.note,
              }],
            },
          },
        };
      }

      const movement = await cash.recordSale(ctx.tenant.business.id, ctx.actorUserId, {
        monto: parsed.amount,
        nota: parsed.note,
        fecha: ctx.now,
      });

      const count = Number(data.count ?? 0) + 1;
      const total = Number(data.total ?? 0) + parsed.amount;

      return {
        reply: {
          text: `🟢 Venta registrada: *${formatCurrency(parsed.amount)}*${parsed.note ? ` (${esc(parsed.note)})` : ''}\n_Total acumulado: ${formatCurrency(total)} (${count})_`,
          parseMode: 'Markdown',
          inlineKeyboard: [
            [{ text: '↩️ Deshacer última venta', callbackData: 'undo:ask' }, { text: '🏁 Finalizar', callbackData: 'continuous:fin' }],
          ],
        },
        updatedData: { ...data, count, total, lastMovementId: movement.id },
        audit: {
          action: 'sale.recorded',
          entityType: 'money_movement',
          entityId: movement.id,
          metadata: { amount: parsed.amount, note: parsed.note },
        },
      };
    },
  };

  const registrarGasto: ActionDef<any> = {
    name: 'registrar_gasto',
    description:
      'Registra salidas de dinero, pagos a proveedores y gastos de servicios de forma ágil y continua.',
    kind: 'read',
    input: RegistrarGastoInput,
    isContinuous: true,
    handler: async (ctx, initialData) => {
      const data = (initialData ?? {}) as Record<string, unknown>;
      if (data.monto && data.concepto) {
        const amount = Number(data.monto);
        const concept = String(data.concepto);
        const category = data.categoria ? String(data.categoria) : undefined;
        const movement = await cash.recordExpense(ctx.tenant.business.id, ctx.actorUserId, {
          monto: amount,
          concepto: concept,
          categoria: category,
          fecha: ctx.now,
        });
        const conceptPart = concept ? ` - ${esc(concept)}` : '';
        return {
          reply: [
            `🔴 Gasto registrado: *${formatCurrency(amount)}*${conceptPart}`,
            `_Total acumulado: ${formatCurrency(amount)} (1)_`,
            '',
            'Podés seguir enviando gastos para sumar a esta tanda o tocar Finalizar.',
          ].join('\n'),
          inlineKeyboard: [
            [{ text: '↩️ Deshacer último gasto', callbackData: 'undo:ask' }, { text: '🏁 Finalizar', callbackData: 'continuous:fin' }],
          ],
          audit: {
            action: 'expense.recorded',
            entityType: 'money_movement',
            entityId: movement.id,
            metadata: { amount, concept, category },
          },
        };
      }

      return {
        reply: [
          '🔴 *Registro de gastos*',
          'Mandá el monto y el concepto (ej: *3500 coca* o *12000 luz*).',
          '',
          '💡 _Tip: Para audios, te sugerimos que duren menos de 1 minuto para que la transcripción sea instantánea._',
          '',
          'Podés finalizar o deshacer con los botones abajo cuando quieras.',
        ].join('\n'),
        inlineKeyboard: [
          [{ text: '🏁 Finalizar', callbackData: 'continuous:fin' }, { text: '❌ Cancelar', callbackData: 'continuous:cancel' }],
        ],
      };
    },
    handleContinuousStep: async (ctx, text, data) => {
      const lower = text.trim().toLowerCase();
      if (lower === '/fin' || lower === 'fin' || lower === 'finalizar') {
        const count = Number(data.count ?? 0);
        const total = Number(data.total ?? 0);
        return {
          reply: {
            text: [
              '🏁 *Registro de gastos finalizado*',
              '',
              `• Gastos registrados: *${count}*`,
              `• Total acumulado: *${formatCurrency(total)}*`,
            ].join('\n'),
            parseMode: 'Markdown',
          },
          finished: true,
        };
      }

      if (lower === '/deshacer' || lower === 'deshacer') {
        const undone = await cash.undoLast(ctx.tenant.business.id, ctx.actorUserId);
        if (!undone) {
          return {
            reply: { text: 'No hay gastos recientes para anular.', parseMode: 'Markdown' },
          };
        }
        const undoneAmount = Number(undone.amount);
        const count = Math.max(0, Number(data.count ?? 1) - 1);
        const total = Math.max(0, Number(data.total ?? undoneAmount) - undoneAmount);
        return {
          reply: {
            text: `↩️ Se anuló el último gasto de *${formatCurrency(undoneAmount)}*.\n_Total acumulado: ${formatCurrency(total)} (${count})_`,
            parseMode: 'Markdown',
            inlineKeyboard: count > 0
              ? [
                  [{ text: '↩️ Deshacer último gasto', callbackData: 'undo:ask' }, { text: '🏁 Finalizar', callbackData: 'continuous:fin' }],
                ]
              : [
                  [{ text: '🏁 Finalizar', callbackData: 'continuous:fin' }],
                ],
          },
          updatedData: { ...data, count, total },
        };
      }

      // 1. Si había un importe pendiente sin concepto
      if (data._pendingExpenseAmount) {
        const amount = Number(data._pendingExpenseAmount);
        const concept = text.trim();
        const movement = await cash.recordExpense(ctx.tenant.business.id, ctx.actorUserId, {
          monto: amount,
          concepto: concept,
          fecha: ctx.now,
        });
        const count = Number(data.count ?? 0) + 1;
        const total = Number(data.total ?? 0) + amount;
        const nextData: Record<string, unknown> = { ...data, count, total, lastMovementId: movement.id };
        delete nextData._pendingExpenseAmount;

        const conceptPart = concept ? ` - ${esc(concept)}` : '';
        return {
          reply: {
            text: `🔴 Gasto registrado: *${formatCurrency(amount)}*${conceptPart}\n_Total acumulado: ${formatCurrency(total)} (${count})_`,
            parseMode: 'Markdown',
            inlineKeyboard: [
              [{ text: '↩️ Deshacer último gasto', callbackData: 'undo:ask' }, { text: '🏁 Finalizar', callbackData: 'continuous:fin' }],
            ],
          },
          updatedData: nextData,
        };
      }

      // 2. Ráfaga o audio con gastos (si es audio, pide confirmación siempre para prevenir errores de transcripción)
      const multiple = parseExpensesList(text);
      if (multiple && (multiple.length > 1 || (ctx.isVoice && multiple.length > 0))) {
        return {
          reply: { text: 'Entendido. Preparando confirmación...' },
          switchToConfirming: {
            actionName: 'registrar_lote',
            data: {
              origen: ctx.isVoice ? 'audio' : 'texto',
              items: multiple.map((m) => ({
                tipo: 'GASTO',
                monto: m.amount,
                concepto: m.concepto,
              })),
            },
          },
        };
      }

      // 3. Importe único sin concepto: ej "5000"
      const bareNum = parseAmountAndNote(text);
      if (bareNum && !bareNum.note) {
        return {
          reply: {
            text: `⚠️ ¿En qué gastaste los *${formatCurrency(bareNum.amount)}*? Escribí el concepto (ej: *pan*, *luz*, *proveedor*) para categorizarlo bien.`,
            parseMode: 'Markdown',
            inlineKeyboard: [
              [{ text: '🏁 Finalizar', callbackData: 'continuous:fin' }, { text: '❌ Cancelar', callbackData: 'continuous:cancel' }],
            ],
          },
          updatedData: { ...data, _pendingExpenseAmount: bareNum.amount },
        };
      }

      // 4. Importe con concepto directo: ej "3500 coca", "coca 3500", "3000 en pan"
      let amount: number | undefined;
      let concept: string | undefined;

      if (bareNum && bareNum.note) {
        amount = bareNum.amount;
        concept = bareNum.note.replace(/^(?:en|de|a|por)\s+/i, '').trim();
      } else {
        const inv = text.match(/^(.*?)\s+(?:por|a|en)?\s*\$?([\d.,]+)$/i);
        if (inv) {
          const num = parseAmountAndNote(inv[2]);
          if (num && num.amount > 0) {
            amount = num.amount;
            concept = inv[1].replace(/^(?:en|de|a|por)\s+/i, '').trim();
          }
        }
      }

      if (!amount || !concept) {
        return {
          reply: {
            text: '⚠️ Mandá el monto y el concepto (ej. *3500 coca* o *12000 luz*), o tocá *🏁 Finalizar*.',
            parseMode: 'Markdown',
            inlineKeyboard: [
              [{ text: '🏁 Finalizar', callbackData: 'continuous:fin' }, { text: '❌ Cancelar', callbackData: 'continuous:cancel' }],
            ],
          },
        };
      }

      if (ctx.isVoice) {
        return {
          reply: { text: 'Entendido. Preparando confirmación...' },
          switchToConfirming: {
            actionName: 'registrar_lote',
            data: {
              origen: 'audio',
              items: [{
                tipo: 'GASTO',
                monto: amount,
                concepto: concept,
              }],
            },
          },
        };
      }

      const movement = await cash.recordExpense(ctx.tenant.business.id, ctx.actorUserId, {
        monto: amount,
        concepto: concept,
        fecha: ctx.now,
      });

      const count = Number(data.count ?? 0) + 1;
      const total = Number(data.total ?? 0) + amount;

      const conceptPart = concept ? ` - ${esc(concept)}` : '';
      return {
        reply: {
          text: `🔴 Gasto registrado: *${formatCurrency(amount)}*${conceptPart}\n_Total acumulado: ${formatCurrency(total)} (${count})_`,
          parseMode: 'Markdown',
          inlineKeyboard: [
            [{ text: '↩️ Deshacer último gasto', callbackData: 'undo:ask' }, { text: '🏁 Finalizar', callbackData: 'continuous:fin' }],
          ],
        },
        updatedData: { ...data, count, total, lastMovementId: movement.id },
        audit: {
          action: 'expense.recorded',
          entityType: 'money_movement',
          entityId: movement.id,
          metadata: { amount, concept },
        },
      };
    },
  };

  const deshacerUltimo: ActionDef<Empty> = {
    name: 'deshacer_ultimo',
    description: 'Anula o revierte el último movimiento registrado (venta o gasto). No requiere datos.',
    kind: 'write',
    input: EmptyInput,
    summarize: () => '¿Confirmás anular la última acción registrada?',
    handler: async (ctx) => {
      const undone = await cash.undoLast(ctx.tenant.business.id, ctx.actorUserId);
      if (!undone) {
        return { reply: 'No hay movimientos recientes para deshacer.' };
      }
      const label = undone.kind === 'IN' ? '🟢 Venta' : '🔴 Gasto';
      return {
        reply: `↩️ Se anuló el último movimiento:\n${label} de *${formatCurrency(Number(undone.amount))}* (${esc(undone.concept)}).`,
        audit: {
          action: 'movement.undone',
          entityType: 'money_movement',
          entityId: undone.id,
          metadata: {
            amount: Number(undone.amount),
            kind: undone.kind,
            concept: undone.concept,
            category: undone.category,
          },
        },
      };
    },
  };

  const calcularPrecio: ActionDef<CalcularPrecio> = {
    name: 'calcular_precio',
    description:
      'Calcula el precio de venta sugerido y la ganancia a partir de un costo (unitario o por lote) y un porcentaje opcional. Si no se indica porcentaje, muestra 3 escenarios recomendados de kiosco.',
    kind: 'read',
    input: CalcularPrecioInput,
    intro:
      'Para calcular un precio podés decir: *"Compré 30 alfajores por 18000 a cuánto los vendo"* o *"Costo 600, 40% de margen"*.',
    handler: async (_ctx, input) => {
      let unitCost = input.costo_unitario;
      if (unitCost === undefined && input.costo_total !== undefined && input.cantidad !== undefined && input.cantidad > 0) {
        unitCost = input.costo_total / input.cantidad;
      }
      if (unitCost === undefined && input.costo_total !== undefined && (!input.cantidad || input.cantidad === 1)) {
        unitCost = input.costo_total;
      }

      // Si no especificó porcentaje -> Asesor de precios con 3 escenarios típicos de kiosco
      if (input.porcentaje === undefined) {
        if (!unitCost) {
          return {
            reply: '¿Cuál es el costo del producto o del lote? Decime por ejemplo: *"Compré 30 alfajores por 18000 a cuánto los vendo"* o *"Costo unitario 600"*.',
          };
        }

        const qty = input.cantidad ?? 1;
        const r30 = Math.round(unitCost * 1.3);
        const g30 = r30 - unitCost;
        const r50 = Math.round(unitCost * 1.5);
        const g50 = r50 - unitCost;
        const r75 = Math.round(unitCost * 1.75);
        const g75 = r75 - unitCost;

        const loteInfo =
          input.cantidad && input.cantidad > 1
            ? [
                `📦 Lote de *${input.cantidad} unidades* (Costo total: *${formatCurrency(input.costo_total ?? unitCost * input.cantidad)}*)`,
                `💵 Costo por unidad: *${formatCurrency(unitCost)}*`,
                '',
              ]
            : [`💵 Costo base por unidad: *${formatCurrency(unitCost)}*`, ''];

        return {
          reply: [
            '🧮 *Precios sugeridos de venta (guía de kiosco):*',
            '',
            ...loteInfo,
            `🟡 *Rotación rápida (+30% recargo):*`,
            `  👉 Precio: *${formatCurrency(r30)}* c/u`,
            `  💰 Ganás *${formatCurrency(g30)}* por unidad${qty > 1 ? ` (Lote: *${formatCurrency(g30 * qty)}*)` : ''}`,
            '',
            `🟢 *Kiosco estándar (+50% recargo - recomendado):*`,
            `  👉 Precio: *${formatCurrency(r50)}* c/u`,
            `  💰 Ganás *${formatCurrency(g50)}* por unidad${qty > 1 ? ` (Lote: *${formatCurrency(g50 * qty)}*)` : ''}`,
            '',
            `🔵 *Mayor ganancia (+75% recargo):*`,
            `  👉 Precio: *${formatCurrency(r75)}* c/u`,
            `  💰 Ganás *${formatCurrency(g75)}* por unidad${qty > 1 ? ` (Lote: *${formatCurrency(g75 * qty)}*)` : ''}`,
            '',
            '_💡 Si buscás un porcentaje puntual, decime por ejemplo: "quiero 40% de margen" o "40% recargo"._',
          ].join('\n'),
        };
      }

      if (!input.tipo) {
        if (!unitCost) {
          return {
            reply:
              '¿Cuál es el costo del producto? Decime por ejemplo: *"Costo 4000 y quiero el 15%"* o *"Compré alfajores a 600"*.',
          };
        }

        const pct = input.porcentaje;
        const rMarkup = Math.round(unitCost * (1 + pct / 100));
        const gMarkup = rMarkup - unitCost;

        const rMargen = pct < 100 ? Math.round(unitCost / (1 - pct / 100)) : null;
        const gMargen = rMargen !== null ? rMargen - unitCost : null;

        const qty = input.cantidad && input.cantidad > 1 ? input.cantidad : null;
        const loteMarkup = qty ? ` (Lote: *${formatCurrency(gMarkup * qty)}*)` : '';
        const loteMargen = qty && gMargen !== null ? ` (Lote: *${formatCurrency(gMargen * qty)}*)` : '';

        const headerLote = qty
          ? `📦 *Lote de ${qty} unidades* (Costo total: *${formatCurrency(input.costo_total ?? unitCost * qty)}*)\n`
          : '';

        const margenBlock =
          rMargen !== null
            ? [
                `• *Si calculás con Margen (sobre la venta):*`,
                `  El ${pct}% del total que cobra la caja es tu ganancia.`,
                '',
                `  👉 Precio sugerido: *${formatCurrency(rMargen)}*${qty ? ' c/u' : ''}`,
                `  💰 Ganancia: *${formatCurrency(gMargen)}* por unidad${loteMargen}`,
              ]
            : [
                `• *Margen (sobre la venta):*`,
                `  El margen debe ser menor al 100% (no es posible ganar el 100% de la venta si el producto tuvo costo).`,
              ];

        return {
          reply: [
            `${headerLote}🧮 *Costo unitario:* *${formatCurrency(unitCost)}* _(para ganar ${pct}%)_`,
            '',
            `• *Si calculás con Recargo (sobre el costo):*`,
            `  Le sumás el ${pct}% arriba de lo que pagaste.`,
            '',
            `  👉 Precio sugerido: *${formatCurrency(rMarkup)}*${qty ? ' c/u' : ''}`,
            `  💰 Ganancia: *${formatCurrency(gMarkup)}* por unidad${loteMarkup}`,
            '',
            ...margenBlock,
          ].join('\n'),
        };
      }

      const calc = cash.calculatePrice({
        costoTotal: input.costo_total,
        cantidad: input.cantidad,
        costoUnitario: input.costo_unitario,
        porcentaje: input.porcentaje,
        tipo: input.tipo,
      });

      const formulaLabel = calc.tipo === 'margen' ? 'Margen sobre venta' : 'Recargo sobre costo';
      const loteLines = calc.cantidad
        ? [
            `📦 Cantidad: *${calc.cantidad} unidades*`,
            calc.costoTotal ? `💵 Costo del lote: *${formatCurrency(calc.costoTotal)}*` : '',
            `📈 Ganancia total del lote: *${formatCurrency(calc.gananciaLote ?? 0)}*`,
          ].filter(Boolean)
        : [];

      return {
        reply: [
          `🧮 *Precio sugerido (${formulaLabel}):*`,
          '',
          `• Costo unitario: *${formatCurrency(calc.costoUnitario)}*`,
          `• ${calc.tipo === 'margen' ? 'Margen' : 'Recargo'}: *${calc.porcentaje}%*`,
          `• *Precio de venta: ${formatCurrency(calc.precioSugerido)}*`,
          '',
          `💰 Ganancia por unidad: *${formatCurrency(calc.gananciaUnitaria)}*`,
          ...loteLines,
        ].join('\n'),
      };
    },
  };

  const statsMenuKeyboard = [
    [
      { text: '📅 Hoy', callbackData: 'stats:hoy' },
      { text: '📅 Ayer', callbackData: 'stats:ayer' },
    ],
    [
      { text: '🗓️ Esta semana', callbackData: 'stats:semana' },
      { text: '🗓️ Este mes', callbackData: 'stats:mes:0' },
    ],
    [
      { text: '🏷️ Gastos por categoría', callbackData: 'stats:categorias' },
      { text: '📋 Últimos movimientos', callbackData: 'stats:movimientos' },
    ],
  ];

  const periodNavKeyboard = (current: string) => [
    [
      { text: current === 'hoy' ? '• Hoy •' : '📅 Hoy', callbackData: 'stats:hoy' },
      { text: current === 'ayer' ? '• Ayer •' : '📅 Ayer', callbackData: 'stats:ayer' },
      { text: current === 'semana' ? '• Semana •' : '🗓️ Semana', callbackData: 'stats:semana' },
      { text: current === 'mes' ? '• Mes •' : '🗓️ Mes', callbackData: 'stats:mes:0' },
    ],
    [
      { text: '🏷️ Gastos por categoría', callbackData: 'stats:categorias' },
      { text: '⬅️ Menú estadísticas', callbackData: 'stats:menu' },
    ],
  ];

  const monthNavKeyboard = (offset: number) => {
    const navRow = [
      { text: '◀️ Mes anterior', callbackData: `stats:mes:${offset - 1}` },
    ];
    if (offset < 0) {
      navRow.push({ text: 'Mes siguiente ▶️', callbackData: `stats:mes:${offset + 1}` });
    }
    return [
      navRow,
      [
        { text: '📅 Ver semanas del mes', callbackData: `stats:semanas:${offset}` },
      ],
      [
        { text: '📅 Hoy', callbackData: 'stats:hoy' },
        { text: '🗓️ Esta semana', callbackData: 'stats:semana' },
        { text: '⬅️ Menú estadísticas', callbackData: 'stats:menu' },
      ],
    ];
  };

  const weeksNavKeyboard = (offset: number) => {
    const navRow = [
      { text: '◀️ Semanas mes ant.', callbackData: `stats:semanas:${offset - 1}` },
    ];
    if (offset < 0) {
      navRow.push({ text: 'Semanas mes sig. ▶️', callbackData: `stats:semanas:${offset + 1}` });
    }
    return [
      navRow,
      [
        { text: '📊 Total del mes', callbackData: `stats:mes:${offset}` },
        { text: '⬅️ Menú estadísticas', callbackData: 'stats:menu' },
      ],
    ];
  };

  const consultarResumen: ActionDef<ConsultarResumen> = {
    name: 'consultar_resumen',
    description:
      'Muestra el resumen de ventas, gastos y balance de caja de un período. Dato: periodo ("hoy", "ayer", "semana", "mes", "mes:-1", "semanas", "semanas:-1", "categorias", "movimientos", "menu"). Por defecto "hoy".',
    kind: 'read',
    roles: ['OWNER'],
    input: ConsultarResumenInput,
    handler: async (ctx, input) => {
      if (ctx.tenant.membership.role === 'EMPLOYEE') {
        return {
          reply: 'Solo el dueño del negocio puede consultar las estadísticas y el balance de caja.',
        };
      }
      const periodo = input?.periodo ?? 'menu';
      if (periodo === 'menu') {
        return {
          reply: [
            '📊 *Estadísticas de tu negocio*',
            'Elegí qué período o información querés consultar:',
          ].join('\n'),
          inlineKeyboard: statsMenuKeyboard,
        };
      }

      if (periodo === 'categorias') {
        const tz = ctx.tenant.business.timezone;
        const cats = await cash.getExpensesByCategory(ctx.tenant.business.id, ctx.now, tz);
        if (cats.length === 0) {
          return {
            reply: '🏷️ *Gastos por categoría (este mes):*\n\nTodavía no hay gastos registrados este mes.',
            inlineKeyboard: [
              [{ text: '📊 Ver balance de caja', callbackData: 'stats:hoy' }, { text: '⬅️ Menú estadísticas', callbackData: 'stats:menu' }],
            ],
          };
        }
        const totalGastos = cats.reduce((acc, c) => acc + c.total, 0);
        const lines = cats.map((c) => `• ${esc(c.category)}: *${formatCurrency(c.total)}* (${c.count} ${c.count === 1 ? 'gasto' : 'gastos'})`);
        return {
          reply: [
            '🏷️ *Gastos por categoría (este mes):*',
            '',
            ...lines,
            '',
            `Total gastos: *${formatCurrency(totalGastos)}*`,
          ].join('\n'),
          inlineKeyboard: [
            [{ text: '📊 Ver balance de caja', callbackData: 'stats:hoy' }, { text: '⬅️ Menú estadísticas', callbackData: 'stats:menu' }],
          ],
        };
      }

      if (periodo === 'movimientos') {
        const list = await cash.listRecent(ctx.tenant.business.id, 10);
        if (list.length === 0) {
          return {
            reply: '📋 *Últimos movimientos:*\n\nTodavía no hay movimientos registrados.',
            inlineKeyboard: [[{ text: '⬅️ Menú estadísticas', callbackData: 'stats:menu' }]],
          };
        }
        const lines = list.map((m) => {
          const icon = m.kind === 'IN' ? '🟢' : '🔴';
          const sign = m.kind === 'IN' ? '+' : '-';
          return `${icon} ${esc(m.concept)}: *${sign}${formatCurrency(Number(m.amount))}* _(${formatDateTime(m.date)})_`;
        });
        return {
          reply: ['📋 *Últimos 10 movimientos:*', '', ...lines].join('\n'),
          inlineKeyboard: [
            [{ text: '📊 Ver balance de caja', callbackData: 'stats:hoy' }, { text: '⬅️ Menú estadísticas', callbackData: 'stats:menu' }],
          ],
        };
      }

      if (periodo.startsWith('semanas')) {
        const parts = periodo.split(':');
        const offset = parts.length > 1 ? parseInt(parts[1], 10) || 0 : 0;
        const tz = ctx.tenant.business.timezone;
        const nowParts = getZonedParts(ctx.now, tz);
        const targetRef = zonedDateToUtc(nowParts.year, nowParts.month + offset, 15, 12, 0, 0, 0, tz);
        const targetParts = getZonedParts(targetRef, tz);
        const monthNames = [
          'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
          'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
        ];
        const monthName = monthNames[targetParts.month];
        const targetYear = targetParts.year;

        const weeks = await cash.getMonthWeeksSummary(ctx.tenant.business.id, targetRef, tz);

        const weekLines = weeks.map((w) => {
          if (w.ventasCount === 0 && w.gastosCount === 0) {
            return `• *${w.label}*\n  _Sin movimientos registrados_`;
          }
          const wSign = w.balanceCaja >= 0 ? '+' : '';
          return [
            `• *${w.label}*`,
            `  🛒 Ventas: *${formatCurrency(w.ventasTotal)}* (${w.ventasCount}) | 💸 Gastos: *${formatCurrency(w.gastosTotal)}* (${w.gastosCount})`,
            `  ⚖️ Balance: *${wSign}${formatCurrency(w.balanceCaja)}*`,
          ].join('\n');
        });

        const totalVentas = weeks.reduce((acc, w) => acc + w.ventasTotal, 0);
        const totalGastos = weeks.reduce((acc, w) => acc + w.gastosTotal, 0);
        const totalCountVentas = weeks.reduce((acc, w) => acc + w.ventasCount, 0);
        const totalCountGastos = weeks.reduce((acc, w) => acc + w.gastosCount, 0);
        const totalBalance = Math.round((totalVentas - totalGastos) * 100) / 100;
        const totalSign = totalBalance >= 0 ? '+' : '';

        return {
          reply: [
            `🗓️ *Semanas de ${monthName} ${targetYear}*`,
            '',
            ...weekLines.flatMap((w) => [w, '']),
            '───────────────',
            `📊 *Total de ${monthName} ${targetYear}:*`,
            `🛒 Ventas: *${formatCurrency(totalVentas)}* (${totalCountVentas})`,
            `💸 Gastos: *${formatCurrency(totalGastos)}* (${totalCountGastos})`,
            '',
            `⚖️ *Resultado en caja: ${totalSign}${formatCurrency(totalBalance)}*`,
          ].join('\n'),
          inlineKeyboard: weeksNavKeyboard(offset),
        };
      }

      if (periodo.startsWith('mes')) {
        const parts = periodo.split(':');
        const offset = parts.length > 1 ? parseInt(parts[1], 10) || 0 : 0;
        const tz = ctx.tenant.business.timezone;
        const nowParts = getZonedParts(ctx.now, tz);
        const targetRef = zonedDateToUtc(nowParts.year, nowParts.month + offset, 15, 12, 0, 0, 0, tz);
        const targetParts = getZonedParts(targetRef, tz);
        const monthNames = [
          'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
          'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
        ];
        const monthName = monthNames[targetParts.month];
        const targetYear = targetParts.year;

        const summary = await cash.getMonthSummary(ctx.tenant.business.id, targetRef, tz);
        const periodLabel = offset === 0 ? `este mes (${monthName} ${targetYear})` : `${monthName} ${targetYear}`;

        const sign = summary.balanceCaja >= 0 ? '+' : '';
        const emptyNote =
          summary.ventasCount === 0 && summary.gastosCount === 0
            ? '\n_Todavía sin movimientos registrados en este período._\n'
            : '';

        return {
          reply: [
            `📊 *Resumen de ${periodLabel}*`,
            '',
            `🛒 Ventas: *${formatCurrency(summary.ventasTotal)}* (${summary.ventasCount} ${summary.ventasCount === 1 ? 'venta' : 'ventas'})`,
            `💸 Gastos: *${formatCurrency(summary.gastosTotal)}* (${summary.gastosCount} ${summary.gastosCount === 1 ? 'gasto' : 'gastos'})`,
            '',
            '',
            `⚖️ *Resultado en caja: ${sign}${formatCurrency(summary.balanceCaja)}*`,
            emptyNote,
            '',
            '_(Nota: balance de flujo neto en efectivo; no deduce costos de mercadería)._',
          ]
            .filter(Boolean)
            .join('\n'),
          inlineKeyboard: monthNavKeyboard(offset),
        };
      }

      let summary: PeriodSummary;
      const tz = ctx.tenant.business.timezone;
      if (periodo === 'ayer') {
        const ayer = new Date(ctx.now.getTime() - 24 * 60 * 60 * 1000);
        summary = await cash.getDaySummary(ctx.tenant.business.id, ayer, tz);
        summary.periodLabel = 'ayer';
      } else if (periodo === 'semana') {
        summary = await cash.getWeekSummary(ctx.tenant.business.id, ctx.now, tz);
      } else {
        summary = await cash.getDaySummary(ctx.tenant.business.id, ctx.now, tz);
      }

      const sign = summary.balanceCaja >= 0 ? '+' : '';
      const emptyNote =
        summary.ventasCount === 0 && summary.gastosCount === 0
          ? '\n_Todavía sin movimientos registrados en este período._\n'
          : '';

      return {
        reply: [
          `📊 *Resumen de ${summary.periodLabel}*`,
          '',
          `🛒 Ventas: *${formatCurrency(summary.ventasTotal)}* (${summary.ventasCount} ${summary.ventasCount === 1 ? 'venta' : 'ventas'})`,
          `💸 Gastos: *${formatCurrency(summary.gastosTotal)}* (${summary.gastosCount} ${summary.gastosCount === 1 ? 'gasto' : 'gastos'})`,
          '',
          '',
          `⚖️ *Resultado en caja: ${sign}${formatCurrency(summary.balanceCaja)}*`,
          emptyNote,
          '',
          '_(Nota: balance de flujo neto en efectivo; no deduce costos de mercadería)._',
        ]
          .filter(Boolean)
          .join('\n'),
        inlineKeyboard: periodNavKeyboard(summary.periodLabel === 'ayer' ? 'ayer' : periodo),
      };
    },
  };

  const consultarMovimientos: ActionDef<ConsultarMovimientos> = {
    name: 'consultar_movimientos',
    description: 'Muestra los últimos movimientos registrados (ventas y gastos). Dato opcional: limite (1 a 30).',
    kind: 'read',
    input: ConsultarMovimientosInput,
    handler: async (ctx, input) => {
      const list = await cash.listRecent(ctx.tenant.business.id, input.limite);
      if (list.length === 0) {
        return { reply: 'Todavía no hay movimientos registrados.' };
      }

      const lines = list.map((m) => {
        const icon = m.kind === 'IN' ? '🟢' : '🔴';
        const sign = m.kind === 'IN' ? '+' : '-';
        return `${icon} ${esc(m.concept)}: *${sign}${formatCurrency(Number(m.amount))}* _(${formatDateTime(m.date)})_`;
      });

      return {
        reply: ['📋 *Últimos movimientos:*', '', ...lines].join('\n'),
      };
    },
  };

  const registrarLote: ActionDef<RegistrarLote> = {
    name: 'registrar_lote',
    description: 'Registra un lote de ventas y/o gastos (proveniente de fotos de libretas o audios multi-monto).',
    kind: 'write',
    input: RegistrarLoteInput,
    confirmButtons: () => [
      [{ text: '✅ Confirmar registro', callbackData: 'confirm:yes' }],
      [
        { text: '✏️ Corregir un monto', callbackData: 'kiosco:correct_prompt' },
        { text: '❌ Cancelar', callbackData: 'confirm:no' },
      ],
    ],
    summarize: (data, ctx) => {
      const lote = data as RegistrarLote;
      const items = lote.items || [];
      const ventas = items.filter((i) => i.tipo === 'VENTA');
      const gastos = items.filter((i) => i.tipo === 'GASTO');
      const isOnlyVentas = gastos.length === 0;
      const isOnlyGastos = ventas.length === 0;
      const totalVentas = ventas.reduce((acc, i) => acc + i.monto, 0);
      const totalGastos = gastos.reduce((acc, i) => acc + i.monto, 0);

      const isAudio = lote.origen === 'audio' || ctx?.isVoice === true;

      const header = isAudio
        ? (items.length === 1
            ? (isOnlyGastos ? '🎤 *Gasto detectado en el audio:*' : '🎤 *Venta detectada en el audio:*')
            : (isOnlyVentas
                ? '🎤 *Ventas detectadas en el audio:*'
                : isOnlyGastos
                  ? '🎤 *Gastos detectados en el audio:*'
                  : '🎤 *Movimientos detectados en el audio:*'))
        : (items.length === 1
            ? (isOnlyGastos ? '📋 *Confirmar gasto:*' : '📋 *Confirmar venta:*')
            : (isOnlyVentas
                ? '📋 *Confirmar ventas:*'
                : isOnlyGastos
                  ? '📋 *Confirmar gastos:*'
                  : '📋 *Confirmar movimientos:*'));

      const lines: string[] = [header, ''];

      if (items.length === 1) {
        const item = items[0];
        if (item.tipo === 'GASTO') {
          const conceptPart = item.concepto?.trim() ? ` - ${esc(item.concepto.trim())}` : '';
          lines.push(`🔴 *${formatCurrency(item.monto)}*${conceptPart}`);
        } else {
          const notePart = item.nota?.trim() ? ` (${esc(item.nota.trim())})` : '';
          lines.push(`🟢 *${formatCurrency(item.monto)}*${notePart}`);
        }
        lines.push('');
        lines.push('¿Confirmás el registro o querés corregir algo?');
        lines.push('_(Podés tocar ✅ Confirmar registro, ✏️ Corregir un monto, o escribir ej: "es 900000")_');
      } else {
        items.forEach((item, idx) => {
          const icon = item.tipo === 'VENTA' ? '🟢' : '🔴';
          if (item.tipo === 'VENTA') {
            const label = item.nota ? ` (${esc(item.nota)})` : '';
            lines.push(`${idx + 1}. ${icon} *${formatCurrency(item.monto)}*${label}`);
          } else {
            const cleanConcept = item.concepto?.trim() || 'Gasto';
            lines.push(`${idx + 1}. ${icon} *${formatCurrency(item.monto)}* - ${esc(cleanConcept)}`);
          }
        });

        lines.push('');
        if (isOnlyVentas) {
          lines.push(`• *Total:* *${formatCurrency(totalVentas)}* (${items.length} ${items.length === 1 ? 'venta' : 'ventas'})`);
        } else if (isOnlyGastos) {
          lines.push(`• *Total:* *${formatCurrency(totalGastos)}* (${items.length} ${items.length === 1 ? 'gasto' : 'gastos'})`);
        } else {
          lines.push(`• *Total ventas:* ${formatCurrency(totalVentas)} (${ventas.length})`);
          lines.push(`• *Total gastos:* ${formatCurrency(totalGastos)} (${gastos.length})`);
        }

        lines.push('');
        lines.push('¿Confirmás o querés corregir alguna?');
        lines.push('_(Mandá un texto diciendo la opción que querés cambiar por el monto, ej: "el 2 es 4000" o "borrar 2", o usá el botón de corregir un monto que se encuentra debajo)_');
      }

      return lines.join('\n');
    },
    handler: async (ctx, input) => {
      const date = input.fecha ? new Date(input.fecha) : ctx.now;
      let totalVentas = 0;
      let totalGastos = 0;
      let countVentas = 0;
      let countGastos = 0;
      let lastMovementId = '';

      for (const item of input.items) {
        if (item.tipo === 'VENTA') {
          const mov = await cash.recordSale(ctx.tenant.business.id, ctx.actorUserId, {
            monto: item.monto,
            nota: item.nota,
            fecha: date,
          });
          totalVentas += item.monto;
          countVentas += 1;
          lastMovementId = mov.id;
        } else {
          const mov = await cash.recordExpense(ctx.tenant.business.id, ctx.actorUserId, {
            monto: item.monto,
            concepto: item.concepto ?? 'Gasto',
            categoria: item.categoria,
            fecha: date,
          });
          totalGastos += item.monto;
          countGastos += 1;
          lastMovementId = mov.id;
        }
      }

      const isOnlyGastos = countVentas === 0;
      const isOnlyVentas = countGastos === 0;

      const isYesterday = Math.abs(ctx.now.getTime() - date.getTime()) > 12 * 60 * 60 * 1000;
      const targetLabel = isYesterday ? ' (caja de ayer)' : '';

      const resLines: string[] = [];
      if (isOnlyVentas) {
        if (countVentas === 1) {
          const item = input.items[0];
          const notePart = item.nota?.trim() ? ` _(${esc(item.nota.trim())})_` : '';
          resLines.push(`✅ *Venta registrada con éxito${targetLabel}:*`);
          resLines.push('');
          resLines.push(`🟢 Monto: *${formatCurrency(item.monto)}*${notePart}`);
        } else {
          resLines.push(`✅ *${countVentas} ventas registradas con éxito${targetLabel}:*`);
          resLines.push('');
          for (const item of input.items) {
            const notePart = item.nota?.trim() ? ` _(${esc(item.nota.trim())})_` : '';
            resLines.push(`• *${formatCurrency(item.monto)}*${notePart}`);
          }
          resLines.push('');
          resLines.push(`*Total: ${formatCurrency(totalVentas)}*`);
        }
      } else if (isOnlyGastos) {
        if (countGastos === 1) {
          const item = input.items[0];
          const conceptPart = item.concepto?.trim() ? ` - ${esc(item.concepto.trim())}` : '';
          resLines.push(`✅ *Gasto registrado con éxito${targetLabel}:*`);
          resLines.push('');
          resLines.push(`🔴 *${formatCurrency(item.monto)}*${conceptPart}`);
        } else {
          resLines.push(`✅ *${countGastos} gastos registrados con éxito${targetLabel}:*`);
          resLines.push('');
          for (const item of input.items) {
            const conceptPart = item.concepto?.trim() ? ` - ${esc(item.concepto.trim())}` : '';
            resLines.push(`• 🔴 *${formatCurrency(item.monto)}*${conceptPart}`);
          }
          resLines.push('');
          resLines.push(`*Total: ${formatCurrency(totalGastos)}*`);
        }
      } else {
        resLines.push(`✅ *Lote registrado con éxito${targetLabel}:*`);
        resLines.push('');
        for (const item of input.items) {
          const label = item.tipo === 'VENTA' ? '🟢 Venta' : '🔴 Gasto';
          const detail = (item.tipo === 'VENTA' ? item.nota : item.concepto)?.trim();
          const detailPart = detail ? ` - ${esc(detail)}` : '';
          resLines.push(`• ${label}: *${formatCurrency(item.monto)}*${detailPart}`);
        }
        resLines.push('');
        resLines.push(`• Total ventas: *${formatCurrency(totalVentas)}* (${countVentas} ${countVentas === 1 ? 'venta' : 'ventas'})`);
        resLines.push(`• Total gastos: *${formatCurrency(totalGastos)}* (${countGastos} ${countGastos === 1 ? 'gasto' : 'gastos'})`);
      }

      return {
        reply: resLines.join('\n'),
        audit: {
          action: 'kiosco.lote_registrado',
          metadata: {
            countVentas,
            totalVentas,
            countGastos,
            totalGastos,
            totalItems: input.items.length,
            fecha: date.toISOString(),
          },
        },
      };
    },
  };

  return [
    registrarVenta,
    registrarGasto,
    registrarLote,
    deshacerUltimo,
    calcularPrecio,
    consultarResumen,
    consultarMovimientos,
  ] as unknown as ActionDef<unknown>[];
}

export type { ActionContext };
