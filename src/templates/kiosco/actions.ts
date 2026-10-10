import type { ActionDef, ActionContext } from '../../core/actions/registry.js';
import type { CashService } from './domain/cash.service.js';
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
import { esc, formatCurrency, formatDateTime } from './format.js';
import type { PeriodSummary } from './types.js';

export interface KioscoActionDeps {
  cash: CashService;
}

/** Parsea un texto con monto y concepto/nota opcional para el modo continuo. */
/** Parsea un texto con monto y concepto/nota opcional para el modo continuo. */
export function parseAmountAndNote(raw: string): { amount: number; note?: string } | null {
  const trimmed = raw.trim();
  const match = trimmed.match(/^\$?\s*([\d.,]+)(?:\s+(.*))?$/);
  if (!match) return null;
  const numStr = match[1];
  const note = match[2]?.trim() || undefined;

  let clean = numStr;
  if (clean.includes('.') && clean.includes(',')) {
    clean = clean.replace(/\./g, '').replace(',', '.');
  } else if (clean.includes(',')) {
    clean = clean.replace(',', '.');
  } else if (clean.includes('.')) {
    if (/^\d{1,3}(?:\.\d{3})+$/.test(clean)) {
      clean = clean.replace(/\./g, '');
    } else {
      const parts = clean.split('.');
      if (parts.length === 2 && parts[1].length === 3) {
        clean = parts[0] + parts[1];
      }
    }
  }

  const amount = parseFloat(clean);
  if (isNaN(amount) || amount <= 0) return null;
  return { amount: Math.round(amount * 100) / 100, note };
}

/**
 * Parsea un ítem individual dentro de una lista de montos (ej: "2000", "una de 2.000", "otra de 3.800 puchos").
 */
function parseListItem(part: string): { amount: number; note?: string } | null {
  const trimmed = part.trim();
  if (!trimmed) return null;

  // Si ya es un número directo (con o sin nota)
  const direct = parseAmountAndNote(trimmed);
  if (direct) return direct;

  // Limpiar prefijos comunes de lenguaje natural en audios o texto:
  // "una de 2.000", "otra de 3.800", "venta de 1500", "primera de 2000", "otra de 3500 puchos"
  const match = trimmed.match(
    /^(?:(?:hice|hubo|registré|tuvimos|vendí|vendi|cobré|cobre)\s+)?(?:(?:una|otra|un|otro|primera|segunda|tercera)\s+)?(?:ventas?|operaci[oó]n)?\s*(?:de\s+|por\s+)?\$?\s*([\d.,]+)(?:\s+(.*))?$/i
  );
  if (match) {
    const parsed = parseAmountAndNote(match[1]);
    if (parsed) {
      let note = match[2]?.trim() || undefined;
      if (note) {
        note = note.replace(/^(?:de|en|por)\s+/i, '').trim() || undefined;
      }
      return { amount: parsed.amount, note };
    }
  }

  return null;
}

/**
 * Parsea múltiples ventas de un texto o transcripción de audio (ej: "3200, 2800, 2500", "2000 y 3800", "vendí 5000 y vendí 12000").
 */
export function parseAmountsList(raw: string): Array<{ amount: number; note?: string }> | null {
  const trimmed = raw.trim();

  // Caso A: Separados por comas, saltos de línea o "y"
  if (trimmed.includes(',') || trimmed.includes('\n') || /\s+y\s+/i.test(trimmed)) {
    const parts = trimmed.split(/[\n,]|(?:\s+y\s+)/i).map((p) => p.trim()).filter(Boolean);
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
  const tokens = trimmed.split(/\s+/).filter(Boolean);
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
  const trimmed = raw.trim();
  if (!trimmed.includes(',') && !trimmed.includes('\n') && !/\s+y\s+/i.test(trimmed)) {
    return null;
  }

  const parts = trimmed.split(/[\n,]|(?:\s+y\s+)/i).map((p) => p.trim()).filter(Boolean);
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

    // 1. Caso monto primero: "3000 en coca", "3000 coca", "$5000 pan", "12000 al proveedor"
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
    const matchInverted = cleaned.match(/^(.*?)\s+(?:por|a|en)?\s*\$?([\d.,]+)$/i);
    if (matchInverted) {
      const num = parseAmountAndNote(matchInverted[2]);
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

export function buildKioscoActions(deps: KioscoActionDeps): ActionDef<unknown>[] {
  const { cash } = deps;

  const registrarVenta: ActionDef<RegistrarVenta> = {
    name: 'registrar_venta',
    description:
      'Registra una o más ventas de dinero (entrada de caja). Datos: monto (número positivo) o ventas (lista de {monto, nota}), nota opcional, fecha opcional.',
    kind: 'write',
    input: RegistrarVentaInput,
    intro:
      'Para registrar ventas decime el monto o los importes, por ejemplo: *"Vendí 5000"*, *"Venta 3200"* o *"Vendí 2500 y 4000"*.',
    fieldPrompts: {
      monto: '¿Cuánto fue el importe de la venta?',
    },
    summarize: (i) => {
      if (i.ventas && i.ventas.length > 0) {
        const total = i.ventas.reduce((acc, v) => acc + v.monto, 0);
        const lines = i.ventas.map((v) => `• *${formatCurrency(v.monto)}*${v.nota ? ` (${esc(v.nota)})` : ''}`).join('\n');
        return `Entendí las ventas:\n${lines}\n\nTotal: *${formatCurrency(total)}*\n\n¿Confirmar?`;
      }
      const amount = i.monto ?? 0;
      return `¿Confirmás registrar la venta de *${formatCurrency(amount)}*${i.nota ? ` (${esc(i.nota)})` : ''}?`;
    },
    handler: async (ctx, input) => {
      const date = input.fecha ? new Date(input.fecha) : ctx.now;
      if (input.ventas && input.ventas.length > 0) {
        let total = 0;
        for (const v of input.ventas) {
          total += v.monto;
          await cash.recordSale(ctx.tenant.business.id, ctx.actorUserId, {
            monto: v.monto,
            nota: v.nota,
            fecha: date,
          });
        }
        return {
          reply: `✅ Registradas *${input.ventas.length}* ventas por un total de *${formatCurrency(total)}*.`,
          inlineKeyboard: [[{ text: '↩️ Deshacer última acción', callbackData: 'undo:ask' }]],
          audit: {
            action: 'sales.batch_recorded',
            metadata: { count: input.ventas.length, total },
          },
        };
      }

      const movement = await cash.recordSale(ctx.tenant.business.id, ctx.actorUserId, {
        monto: input.monto!,
        nota: input.nota,
        fecha: date,
      });

      return {
        reply: `🟢 Venta registrada: *${formatCurrency(input.monto!)}*${input.nota ? ` (${esc(input.nota)})` : ''}.`,
        inlineKeyboard: [[{ text: '↩️ Deshacer última acción', callbackData: 'undo:ask' }]],
        audit: {
          action: 'sale.recorded',
          entityType: 'money_movement',
          entityId: movement.id,
          metadata: { amount: input.monto, note: input.nota },
        },
      };
    },
  };

  const registrarGasto: ActionDef<RegistrarGasto> = {
    name: 'registrar_gasto',
    description:
      'Registra uno o más gastos o compras a proveedores (salida de dinero). Datos: monto (número positivo) o gastos (lista de {monto, concepto, categoria}), concepto, categoria opcional, fecha opcional.',
    kind: 'write',
    input: RegistrarGastoInput,
    intro:
      'Para registrar gastos decime qué pagaste y el monto. Por ejemplo: *"Gasté 3500 en Coca"*, *"Pagué 12000 al proveedor"* o *"Gasté 3000 en coca y 5000 en pan"*.',
    fieldPrompts: {
      monto: '¿Cuánto pagaste o gastaste?',
      concepto: '¿En qué concepto o a quién le pagaste?',
    },
    summarize: (i) => {
      if (i.gastos && i.gastos.length > 0) {
        const total = i.gastos.reduce((acc, g) => acc + g.monto, 0);
        const lines = i.gastos
          .map((g) => `• *${formatCurrency(g.monto)}* (${esc(g.concepto)})`)
          .join('\n');
        return `Entendí los gastos:\n${lines}\n\nTotal: *${formatCurrency(total)}*\n\n¿Confirmar?`;
      }
      const monto = i.monto ?? 0;
      const concepto = i.concepto ?? 'Gasto';
      return `¿Confirmás registrar el gasto de *${formatCurrency(monto)}* en *${esc(concepto)}*${i.categoria ? ` [${esc(i.categoria)}]` : ''}?`;
    },
    handler: async (ctx, input) => {
      const date = input.fecha ? new Date(input.fecha) : ctx.now;
      if (input.gastos && input.gastos.length > 0) {
        let total = 0;
        for (const g of input.gastos) {
          total += g.monto;
          await cash.recordExpense(ctx.tenant.business.id, ctx.actorUserId, {
            monto: g.monto,
            concepto: g.concepto,
            categoria: g.categoria,
            fecha: date,
          });
        }
        return {
          reply: `✅ Registrados *${input.gastos.length}* gastos por un total de *${formatCurrency(total)}*.`,
          inlineKeyboard: [[{ text: '↩️ Deshacer última acción', callbackData: 'undo:ask' }]],
          audit: {
            action: 'expenses.batch_recorded',
            metadata: { count: input.gastos.length, total },
          },
        };
      }

      const movement = await cash.recordExpense(ctx.tenant.business.id, ctx.actorUserId, {
        monto: input.monto!,
        concepto: input.concepto!,
        categoria: input.categoria,
        fecha: date,
      });

      return {
        reply: `🔴 Gasto registrado: *${formatCurrency(input.monto!)}*\nConcepto: *${esc(input.concepto!)}*\nCategoría: *${esc(movement.category ?? 'Otros')}*.`,
        inlineKeyboard: [[{ text: '↩️ Deshacer última acción', callbackData: 'undo:ask' }]],
        audit: {
          action: 'expense.recorded',
          entityType: 'money_movement',
          entityId: movement.id,
          metadata: { amount: input.monto, concept: input.concepto, category: movement.category },
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
        const costStr = unitCost !== undefined ? ` (costo unitario: *${formatCurrency(unitCost)}*)` : '';
        const pct = input.porcentaje;
        const ejMarkup = unitCost ? formatCurrency(unitCost * (1 + pct / 100)) : `costo + ${pct}%`;
        const ejMargen =
          unitCost && pct < 100 ? formatCurrency(unitCost / (1 - pct / 100)) : `costo / (1 - ${pct}%)`;

        return {
          reply: [
            `🧮 ${costStr ? `Costo unitario: *${formatCurrency(unitCost!)}*.\n\n` : ''}¿Querés calcular usando *margen* o *recargo* para ganar *${pct}%*?`,
            '',
            `• *Recargo / Markup* (sobre costo):\n  Precio = costo × (1 + ${pct}%)\n  👉 Precio: *${ejMarkup}*`,
            '',
            `• *Margen* (sobre precio de venta final):\n  Precio = costo / (1 - ${pct}%)\n  👉 Precio: *${ejMargen}*`,
            '',
            'Respondé *"margen"* o *"recargo"*.',
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
      { text: '🗓️ Este mes', callbackData: 'stats:mes' },
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
      { text: current === 'mes' ? '• Mes •' : '🗓️ Mes', callbackData: 'stats:mes' },
    ],
    [
      { text: '🏷️ Gastos por categoría', callbackData: 'stats:categorias' },
      { text: '⬅️ Menú estadísticas', callbackData: 'stats:menu' },
    ],
  ];

  const consultarResumen: ActionDef<ConsultarResumen> = {
    name: 'consultar_resumen',
    description:
      'Muestra el resumen de ventas, gastos y balance de caja de un período. Dato: periodo ("hoy", "ayer", "semana", "mes", "categorias", "movimientos", "menu"). Por defecto "hoy".',
    kind: 'read',
    input: ConsultarResumenInput,
    handler: async (ctx, input) => {
      if (input.periodo === 'menu') {
        return {
          reply: [
            '📊 *Estadísticas de tu negocio*',
            'Elegí qué período o información querés consultar:',
          ].join('\n'),
          inlineKeyboard: statsMenuKeyboard,
        };
      }

      if (input.periodo === 'categorias') {
        const cats = await cash.getExpensesByCategory(ctx.tenant.business.id, ctx.now);
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

      if (input.periodo === 'movimientos') {
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

      let summary: PeriodSummary;
      if (input.periodo === 'ayer') {
        const ayer = new Date(ctx.now.getTime() - 24 * 60 * 60 * 1000);
        summary = await cash.getDaySummary(ctx.tenant.business.id, ayer);
        summary.periodLabel = 'ayer';
      } else if (input.periodo === 'semana') {
        summary = await cash.getWeekSummary(ctx.tenant.business.id, ctx.now);
      } else if (input.periodo === 'mes') {
        summary = await cash.getMonthSummary(ctx.tenant.business.id, ctx.now);
      } else {
        summary = await cash.getDaySummary(ctx.tenant.business.id, ctx.now);
      }

      const sign = summary.balanceCaja >= 0 ? '+' : '';
      const emptyNote =
        summary.ventasCount === 0 && summary.gastosCount === 0
          ? '\n_Todavía sin movimientos registrados en este período._\n'
          : '';

      return {
        reply: [
          `📊 *Resumen de ${summary.periodLabel}:*`,
          '',
          `🛒 Ventas: *${formatCurrency(summary.ventasTotal)}* (${summary.ventasCount} ${summary.ventasCount === 1 ? 'venta' : 'ventas'})`,
          `💸 Gastos: *${formatCurrency(summary.gastosTotal)}* (${summary.gastosCount} ${summary.gastosCount === 1 ? 'gasto' : 'gastos'})`,
          '',
          `⚖️ *Resultado registrado: ${sign}${formatCurrency(summary.balanceCaja)}*`,
          emptyNote,
          '_ℹ️ Este balance representa el flujo neto de dinero registrado, no la ganancia contable real ya que no deduce costos por producto._',
        ]
          .filter(Boolean)
          .join('\n'),
        inlineKeyboard: periodNavKeyboard(summary.periodLabel === 'ayer' ? 'ayer' : input.periodo),
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
    description: 'Registra un lote de ventas y/o gastos (proveniente de fotos de libretas o carga masiva).',
    kind: 'write',
    input: RegistrarLoteInput,
    summarize: (data) => {
      const items = (data as RegistrarLote).items || [];
      const ventas = items.filter((i) => i.tipo === 'VENTA');
      const gastos = items.filter((i) => i.tipo === 'GASTO');
      const totalVentas = ventas.reduce((acc, i) => acc + i.monto, 0);
      const totalGastos = gastos.reduce((acc, i) => acc + i.monto, 0);
      const lines: string[] = ['📋 *Movimientos detectados en la libreta:*', ''];

      const preview = items.slice(0, 15);
      for (const item of preview) {
        const icon = item.tipo === 'VENTA' ? '🟢' : '🔴';
        const label = item.tipo === 'VENTA'
          ? (item.nota ? `${item.nota}: ` : 'Venta: ')
          : (item.concepto ? `${item.concepto}: ` : 'Gasto: ');
        lines.push(`${icon} ${esc(label)}*${formatCurrency(item.monto)}*`);
      }
      if (items.length > 15) {
        lines.push(`_... y ${items.length - 15} movimientos más_`);
      }
      lines.push('');
      if (ventas.length > 0) {
        lines.push(`• *Total ventas (${ventas.length}):* ${formatCurrency(totalVentas)}`);
      }
      if (gastos.length > 0) {
        lines.push(`• *Total gastos (${gastos.length}):* ${formatCurrency(totalGastos)}`);
      }
      return lines.join('\n');
    },
    handler: async (ctx, input) => {
      const date = input.fecha ? new Date(input.fecha) : ctx.now;
      let totalVentas = 0;
      let totalGastos = 0;
      let countVentas = 0;
      let countGastos = 0;

      for (const item of input.items) {
        if (item.tipo === 'VENTA') {
          await cash.recordSale(ctx.tenant.business.id, ctx.actorUserId, {
            monto: item.monto,
            nota: item.nota,
            fecha: date,
          });
          totalVentas += item.monto;
          countVentas += 1;
        } else {
          await cash.recordExpense(ctx.tenant.business.id, ctx.actorUserId, {
            monto: item.monto,
            concepto: item.concepto ?? 'Gasto',
            categoria: item.categoria,
            fecha: date,
          });
          totalGastos += item.monto;
          countGastos += 1;
        }
      }

      const isYesterday = Math.abs(ctx.now.getTime() - date.getTime()) > 12 * 60 * 60 * 1000;
      const targetLabel = isYesterday ? ' (caja de ayer)' : '';
      const resLines = [`✅ *Lote registrado con éxito${targetLabel}:*`, ''];
      if (countVentas > 0) {
        resLines.push(`🟢 *${countVentas} ventas:* ${formatCurrency(totalVentas)}`);
      }
      if (countGastos > 0) {
        resLines.push(`🔴 *${countGastos} gastos:* ${formatCurrency(totalGastos)}`);
      }

      return {
        reply: resLines.join('\n'),
        inlineKeyboard: [[{ text: '↩️ Deshacer último', callbackData: 'undo:last' }]],
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
