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
    const parts = clean.split('.');
    if (parts.length === 2 && parts[1].length === 3) {
      clean = parts[0] + parts[1];
    }
  }

  const amount = parseFloat(clean);
  if (isNaN(amount) || amount <= 0) return null;
  return { amount: Math.round(amount * 100) / 100, note };
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
      'Para registrar una venta decime el monto, por ejemplo: *"Vendí 5000"*, *"Venta 3200"* o *"Vendí 2500 y 4000"*.\n\n_Tip: También podés usar /ventas para modo continuo rápido._',
    fieldPrompts: {
      monto: '¿Cuánto fue el importe de la venta?',
    },
    summarize: (i) => {
      if (i.ventas && i.ventas.length > 0) {
        const total = i.ventas.reduce((acc, v) => acc + v.monto, 0);
        const lines = i.ventas.map((v) => `• *${formatCurrency(v.monto)}*${v.nota ? ` (${esc(v.nota)})` : ''}`).join('\n');
        return `Entendí las ventas:\n${lines}\n\nTotal: *${formatCurrency(total)}*\n\n¿Confirmar?`;
      }
      return `¿Confirmás registrar la venta de *${formatCurrency(i.monto!)}*${i.nota ? ` (${esc(i.nota)})` : ''}?`;
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
          inlineKeyboard: [[{ text: '↩️ Deshacer última', callbackData: 'undo:last' }]],
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
        inlineKeyboard: [[{ text: '↩️ Deshacer', callbackData: 'undo:last' }]],
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
      'Registra un gasto o compra a proveedor (salida de dinero). Datos: monto (número positivo), concepto (descripción, ej. "Coca", "luz", "proveedor"), categoria opcional, fecha opcional.',
    kind: 'write',
    input: RegistrarGastoInput,
    intro:
      'Para registrar un gasto decime qué pagaste y el monto. Ejemplo: *"Gasté 3500 en Coca"*, *"Pagué 12000 al proveedor"* o *"Pagué 15000 de luz"*.\n\n_Tip: También podés usar /gastos para modo continuo rápido._',
    fieldPrompts: {
      monto: '¿Cuánto pagaste o gastaste?',
      concepto: '¿En qué concepto o a quién le pagaste?',
    },
    summarize: (i) =>
      `¿Confirmás registrar el gasto de *${formatCurrency(i.monto)}* en *${esc(i.concepto)}*${i.categoria ? ` [${esc(i.categoria)}]` : ''}?`,
    handler: async (ctx, input) => {
      const date = input.fecha ? new Date(input.fecha) : ctx.now;
      const movement = await cash.recordExpense(ctx.tenant.business.id, ctx.actorUserId, {
        monto: input.monto,
        concepto: input.concepto,
        categoria: input.categoria,
        fecha: date,
      });

      return {
        reply: `🔴 Gasto registrado: *${formatCurrency(input.monto)}*\nConcepto: *${esc(input.concepto)}*\nCategoría: *${esc(movement.category ?? 'Otros')}*.`,
        inlineKeyboard: [[{ text: '↩️ Deshacer', callbackData: 'undo:last' }]],
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
    summarize: () => '¿Confirmás anular el último movimiento registrado?',
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

  const modoVentas: ActionDef<Empty> = {
    name: 'modo_ventas',
    description: 'Activa el modo continuo de ventas para registrar importes seguidos sin confirmación individual.',
    kind: 'read',
    input: EmptyInput,
    isContinuous: true,
    handler: async () => ({
      reply: [
        '🟢 *Modo ventas activo*',
        'Mandá solamente los importes y los voy registrando automáticamente.',
        '',
        '• *2500* → registra venta de $2.500',
        '• *8000* → registra venta de $8.000',
        '',
        'Podés finalizar o deshacer con los botones abajo cuando quieras.',
      ].join('\n'),
      inlineKeyboard: [
        [{ text: '🛑 Finalizar', callbackData: 'continuous:fin' }, { text: '❌ Cancelar', callbackData: 'continuous:cancel' }],
      ],
    }),
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
            inlineKeyboard: [
              [{ text: '🛑 Finalizar', callbackData: 'continuous:fin' }],
            ],
          },
          updatedData: { ...data, count, total },
        };
      }

      const parsed = parseAmountAndNote(text);
      if (!parsed) {
        return {
          reply: {
            text: '⚠️ Mandá solamente el importe (ej. *2500* o *3500 gaseosa*), o tocá *🛑 Finalizar*.',
            parseMode: 'Markdown',
            inlineKeyboard: [
              [{ text: '🛑 Finalizar', callbackData: 'continuous:fin' }, { text: '❌ Cancelar', callbackData: 'continuous:cancel' }],
            ],
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
            [{ text: '↩️ Deshacer última', callbackData: 'undo:last' }, { text: '🛑 Finalizar', callbackData: 'continuous:fin' }],
          ],
        },
        updatedData: { ...data, count, total, lastMovementId: movement.id },
      };
    },
  };

  const modoGastos: ActionDef<Empty> = {
    name: 'modo_gastos',
    description: 'Activa el modo continuo de gastos para registrar salidas de dinero seguidas sin confirmación individual.',
    kind: 'read',
    input: EmptyInput,
    isContinuous: true,
    handler: async () => ({
      reply: [
        '🔴 *Modo gastos activo*',
        'Mandame los gastos (importe y concepto) y los voy registrando automáticamente.',
        '',
        '• *3500 Coca* → registra gasto de $3.500',
        '• *12000 luz* → registra gasto de $12.000',
        '',
        'Podés finalizar o deshacer con los botones abajo cuando quieras.',
      ].join('\n'),
      inlineKeyboard: [
        [{ text: '🛑 Finalizar', callbackData: 'continuous:fin' }, { text: '❌ Cancelar', callbackData: 'continuous:cancel' }],
      ],
    }),
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
            inlineKeyboard: [
              [{ text: '🛑 Finalizar', callbackData: 'continuous:fin' }],
            ],
          },
          updatedData: { ...data, count, total },
        };
      }

      const parsed = parseAmountAndNote(text);
      if (!parsed) {
        return {
          reply: {
            text: '⚠️ Mandá el importe y concepto (ej. *3500 Coca* o *12000 luz*), o tocá *🛑 Finalizar*.',
            parseMode: 'Markdown',
            inlineKeyboard: [
              [{ text: '🛑 Finalizar', callbackData: 'continuous:fin' }, { text: '❌ Cancelar', callbackData: 'continuous:cancel' }],
            ],
          },
        };
      }

      const concepto = parsed.note || 'Gasto';
      const movement = await cash.recordExpense(ctx.tenant.business.id, ctx.actorUserId, {
        monto: parsed.amount,
        concepto,
        fecha: ctx.now,
      });

      const count = Number(data.count ?? 0) + 1;
      const total = Number(data.total ?? 0) + parsed.amount;

      return {
        reply: {
          text: `🔴 Gasto registrado: *${formatCurrency(parsed.amount)}* (${esc(concepto)})\n_Total acumulado: ${formatCurrency(total)} (${count})_`,
          parseMode: 'Markdown',
          inlineKeyboard: [
            [{ text: '↩️ Deshacer última', callbackData: 'undo:last' }, { text: '🛑 Finalizar', callbackData: 'continuous:fin' }],
          ],
        },
        updatedData: { ...data, count, total, lastMovementId: movement.id },
      };
    },
  };

  const calcularPrecio: ActionDef<CalcularPrecio> = {
    name: 'calcular_precio',
    description:
      'Calcula el precio de venta sugerido y la ganancia a partir de un costo (unitario o por lote) y un porcentaje. Datos: costo_total, cantidad, costo_unitario, porcentaje, tipo ("margen" o "recargo").',
    kind: 'read',
    input: CalcularPrecioInput,
    intro:
      'Para calcular un precio podés decir: *"Compré 30 alfajores por 18000, quiero 40% de margen"* o *"Costo 600, 40% recargo"*.',
    handler: async (_ctx, input) => {
      let unitCost = input.costo_unitario;
      if (unitCost === undefined && input.costo_total !== undefined && input.cantidad !== undefined && input.cantidad > 0) {
        unitCost = input.costo_total / input.cantidad;
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

  const consultarResumen: ActionDef<ConsultarResumen> = {
    name: 'consultar_resumen',
    description:
      'Muestra el resumen de ventas, gastos y balance de caja de un período. Dato: periodo ("hoy", "ayer", "semana", "mes"). Por defecto "hoy".',
    kind: 'read',
    input: ConsultarResumenInput,
    handler: async (ctx, input) => {
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

      if (summary.ventasCount === 0 && summary.gastosCount === 0) {
        return { reply: `📊 Todavía no registraste movimientos ${summary.periodLabel}.` };
      }

      const sign = summary.balanceCaja >= 0 ? '+' : '';
      return {
        reply: [
          `📊 *Resumen de ${summary.periodLabel}:*`,
          '',
          `🛒 Ventas: *${formatCurrency(summary.ventasTotal)}* (${summary.ventasCount} ${summary.ventasCount === 1 ? 'venta' : 'ventas'})`,
          `💸 Gastos: *${formatCurrency(summary.gastosTotal)}* (${summary.gastosCount} ${summary.gastosCount === 1 ? 'gasto' : 'gastos'})`,
          '',
          `⚖️ *Resultado registrado: ${sign}${formatCurrency(summary.balanceCaja)}*`,
          '',
          '_ℹ️ Este balance representa el flujo neto de dinero registrado, no la ganancia contable real ya que no deduce costos por producto._',
        ].join('\n'),
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
    modoVentas,
    modoGastos,
    calcularPrecio,
    consultarResumen,
    consultarMovimientos,
  ] as unknown as ActionDef<unknown>[];
}

export type { ActionContext };
