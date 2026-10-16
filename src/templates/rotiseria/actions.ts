import type { ActionDef, ActionContext, InlineButton } from '../../core/actions/registry.js';
import type { ProductService } from './domain/product.service.js';
import type { SaleService } from './domain/sale.service.js';
import type { DeliveryZoneService } from './domain/delivery-zone.service.js';
import {
  AnularVentaInput,
  CambiarPrecioInput,
  ConfigurarEnviosLoteInput,
  ConsultarEstadisticasInput,
  ConsultarMenuInput,
  ControlDiasInput,
  CrearEditarPromoInput,
  CrearProductoInput,
  CrearPromoInput,
  EmptyInput,
  GestionarEnviosInput,
  HistorialVentasInput,
  RegistrarVentaInput,
  ConfigurarBebidasLoteInput,
  GestionarBebidasInput,
  type AnularVentaInput as AnularVenta,
  type CambiarPrecioInput as CambiarPrecio,
  type ConfigurarEnviosLoteInput as ConfigurarEnviosLote,
  type ConsultarEstadisticasInput as ConsultarEstadisticas,
  type ConsultarMenuInput as ConsultarMenu,
  type ControlDiasInput as ControlDias,
  type CrearEditarPromoInput as CrearEditarPromo,
  type CrearProductoInput as CrearProducto,
  type CrearPromoInput as CrearPromo,
  type EmptyInput as Empty,
  type GestionarEnviosInput as GestionarEnvios,
  type HistorialVentasInput as HistorialVentas,
  type RegistrarVentaInput as RegistrarVenta,
  type ConfigurarBebidasLoteInput as ConfigurarBebidasLote,
  type GestionarBebidasInput as GestionarBebidas,
} from './schemas.js';
import {
  esc,
  formatCurrency,
  formatDateTime,
  formatDateOnly,
  formatQty,
  formatRealDateWithDay,
  formatSaleNumber,
  formatSaleReceipt,
  formatSaleSummary,
  formatTimeOnly,
  getCategoryIcon,
} from './format.js';
import { calculatePricing } from './domain/pricing.js';
import { AppError } from '../../core/errors/errors.js';

export interface RotiseriaActionDeps {
  products: ProductService;
  sales: SaleService;
  deliveryZones: DeliveryZoneService;
}

function isValidZoneOrBarrioName(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  if (trimmed.length < 2 || trimmed.length > 50) return false;
  // Descartar si coincide con direcciones de calle con numeración (ej: "calle 123", "av. san martín 450", etc.)
  if (/(?:calle|av\.?|avenida|pasaje|pje\.?|ruta|bvd\.?|boulevard)\s+\d+/i.test(trimmed)) return false;
  if (/\b\d{1,5}\b/.test(trimmed)) return false; // si tiene número de altura (ej: "Mitre 450")
  return true;
}

export function buildRotiseriaActions(deps: RotiseriaActionDeps): ActionDef<unknown>[] {
  const { products, sales, deliveryZones } = deps;

  const registrarVenta: ActionDef<RegistrarVenta> = {
    name: 'registrar_venta',
    description:
      'Registra una venta de rotisería con empanadas, pizzas, sándwiches o promos. Datos: items (lista de {nombre, cantidad}), zona_envio (opcional), flete_monto (opcional), nota (opcional), fecha (opcional, YYYY-MM-DD). El total y docenas los calcula automáticamente el sistema.',
    kind: 'write',
    input: RegistrarVentaInput,
    intro:
      'Para registrar una venta decime qué y cuánto. Ejemplo: *"1 docena de carne y una muzza"* o *"8 empanadas de carne y 4 de pollo con envío a tal lado"*.',
    fieldPrompts: {
      items: '¿Qué se vendió? Decime productos y cantidades, por ejemplo: *"1 docena de carne y 1 pizza"*',
      nombre: '¿Qué producto o promo?',
      cantidad: '¿Qué cantidad?',
    },
    confirmButtons: (input: any) => {
      const rows: InlineButton[][] = [];
      const noRec = Array.isArray(input.no_reconocidos) ? input.no_reconocidos : [];

      for (let idx = 0; idx < noRec.length; idx++) {
        const item = noRec[idx];
        const cant = item.cantidad || 1;
        const texto = item.texto;
        const sugerencia = item.sugerencia;
        if (sugerencia && typeof sugerencia === 'string' && sugerencia.trim() !== '') {
          rows.push([
            {
              text: `¿Era ${sugerencia}? (${cant} u.)`,
              callbackData: `rotiseria:resolver:${encodeURIComponent(sugerencia)}:${cant}`,
            },
            {
              text: `🗑️ Ignorar '${texto}'`,
              callbackData: `rotiseria:ignorar:${idx}`,
            },
          ]);
        }
      }

      // Si hay zona de envío no reconocida, ofrecer botón para asignarle flete manual
      if (
        input.zona_no_reconocida &&
        typeof input.zona_no_reconocida === 'string' &&
        input.zona_no_reconocida.trim() !== ''
      ) {
        const zonaLabel = input.zona_no_reconocida.trim();
        rows.push([
          {
            text: `⚠️ Asignar flete a '${zonaLabel.slice(0, 20)}'`,
            callbackData: `rotiseria:asignar_flete:${encodeURIComponent(zonaLabel)}`,
          },
        ]);
      }

      // Si hay ítems no catalogados con precio $0, ofrecer botón para asignar precio por índice
      // y botón de un toque para quitar la línea errónea
      if (
        Array.isArray(input._uncataloguedZeroItems) &&
        input._uncataloguedZeroItems.length > 0 &&
        Array.isArray(input.items)
      ) {
        for (const uncat of input._uncataloguedZeroItems) {
          const idx = input.items.findIndex(
            (it: any) =>
              String(it.nombre ?? it.name).toLowerCase().trim() === uncat.name.toLowerCase().trim()
          );
          if (idx >= 0) {
            rows.push([
              {
                text: `💵 Asignar precio a '${uncat.name.slice(0, 20)}'`,
                callbackData: `rotiseria:precio_item:${idx}`,
              },
              {
                text: `❌ Quitar '${uncat.name.slice(0, 16)}'`,
                callbackData: `rotiseria:quitar_linea:${idx}`,
              },
            ]);
          }
        }
      }

      // Si está en modo modificación, ofrecer botón rápido para quitar cada ítem del borrador
      if (input._modifying && Array.isArray(input.items) && input.items.length > 0) {
        input.items.forEach((it: any, idx: number) => {
          const itName = String(it.nombre ?? it.name);
          rows.push([
            {
              text: `❌ Quitar ${itName.slice(0, 22)}`,
              callbackData: `rotiseria:quitar_linea:${idx}`,
            },
          ]);
        });
      }

      const hasItems = Array.isArray(input.items) && input.items.length > 0;
      if (hasItems) {
        rows.push([
          { text: '✅ Confirmar venta', callbackData: 'confirm:yes' },
          { text: '❌ Cancelar', callbackData: 'confirm:no' },
        ]);
      } else {
        rows.push([
          { text: '❌ Cancelar', callbackData: 'confirm:no' },
        ]);
      }

      rows.push([
        { text: '🛵 Envíos', callbackData: 'rotiseria:flete_menu' },
        { text: '✏️ Modificar pedido', callbackData: 'rotiseria:modificar' },
      ]);
      rows.push([
        { text: '📅 Cambiar fecha', callbackData: 'rotiseria:fecha' },
      ]);

      return rows;
    },
    summarize: async (i: any, ctx?: ActionContext) => {
      const items = Array.isArray(i.items) ? i.items : [];
      let breakdown: string[] | undefined;
      let total: number | undefined;
      let foodTotal: number | undefined;
      let deliveryFee: number | null | undefined = i.flete_monto;
      let deliveryZoneName: string | null | undefined = i.zona_envio;
      let zonaNoReconocida: string | null | undefined = i.zona_no_reconocida;

      let savedZoneNotice: string | null = null;

      if (ctx) {
        // Resolver o registrar zona de envío
        if (deliveryFee !== undefined && deliveryFee !== null && deliveryZoneName) {
          const rawZone = deliveryZoneName.trim();
          const isGeneric = ['envio', 'envío', 'delivery', 'flete', 'mostrador'].includes(rawZone.toLowerCase());
          if (!isGeneric && isValidZoneOrBarrioName(rawZone)) {
            try {
              const matched = await deliveryZones.findMatching(ctx.tenant.business.id, rawZone);
              if (!matched) {
                const capName = rawZone.charAt(0).toUpperCase() + rawZone.slice(1);
                await deliveryZones.upsertBatch(ctx.tenant.business.id, [
                  {
                    name: capName,
                    price: deliveryFee,
                    barrios: [rawZone.toLowerCase()],
                  },
                ]);
                deliveryZoneName = capName;
                savedZoneNotice = `🛵 Flete asignado: $ ${new Intl.NumberFormat('es-AR').format(deliveryFee)} (Zona '${capName}' guardada para futuros envíos)`;
              } else {
                deliveryZoneName = matched.name;
              }
            } catch {
              // Si falla la persistencia, continuar sin bloquear
            }
          }
        } else if (deliveryFee === undefined && deliveryZoneName) {
          const matched = await deliveryZones.findMatching(ctx.tenant.business.id, deliveryZoneName);
          if (matched) {
            deliveryFee = matched.price;
            deliveryZoneName = matched.name;
          } else {
            zonaNoReconocida = deliveryZoneName;
            deliveryZoneName = null;
          }
        }

        if (items.length > 0) {
          try {
            const catalog = await products.getCatalogLookup(ctx.tenant.business.id);
            const pricing = calculatePricing(
              items.map((it: any) => ({
                name: it.nombre ?? it.name,
                quantity: it.cantidad ?? it.quantity,
                unitPrice: it.precio_unitario !== undefined && it.precio_unitario !== null ? Number(it.precio_unitario) : undefined,
              })),
              catalog,
              deliveryFee !== undefined && deliveryFee !== null
                ? { fee: deliveryFee, zoneName: deliveryZoneName }
                : undefined
            );
            breakdown = pricing.breakdown;
            total = pricing.total;
            foodTotal = pricing.foodTotal;
            deliveryFee = pricing.deliveryFee;
            deliveryZoneName = pricing.deliveryZoneName;
            if (pricing.uncataloguedItems && pricing.uncataloguedItems.length > 0) {
              i._uncataloguedZeroItems = pricing.uncataloguedItems.filter(
                (u) => u.unitPrice === undefined || u.unitPrice === null || u.unitPrice === 0
              );
            } else {
              i._uncataloguedZeroItems = [];
            }
          } catch {
            // Si el catálogo falla o producto no existe, fallback a lista limpia
          }
        }
      }

      const noReconocidos = Array.isArray(i.no_reconocidos)
        ? i.no_reconocidos.map((x: any) =>
            typeof x === 'object' && x !== null
              ? {
                  texto: String(x.texto ?? ''),
                  cantidad: Number(x.cantidad ?? 1),
                  sugerencia: x.sugerencia !== undefined ? (x.sugerencia ? String(x.sugerencia) : null) : undefined,
                }
              : String(x)
          )
        : undefined;

      return formatSaleSummary({
        items,
        nota: i.nota,
        fecha: i.fecha,
        breakdown,
        total,
        foodTotal,
        deliveryFee,
        deliveryZoneName,
        zonaNoReconocida,
        isModifying: Boolean(i._modifying),
        now: ctx?.now,
        timezone: ctx?.tenant.business.timezone,
        savedZoneNotice,
        noReconocidos,
      });
    },
    handler: async (ctx, input) => {
      let customDate: Date | undefined;
      if (input.fecha) {
        const d = new Date(input.fecha.includes('T') ? input.fecha : `${input.fecha}T12:00:00Z`);
        if (!isNaN(d.getTime())) customDate = d;
      }

      let deliveryInput: { fee?: number | null; zoneName?: string | null } | undefined;
      if (input.flete_monto !== undefined && input.flete_monto !== null) {
        const rawZone = (input.zona_envio ?? 'Envío').trim();
        const isGeneric = ['envio', 'envío', 'delivery', 'flete', 'mostrador'].includes(rawZone.toLowerCase());
        let finalZoneName = rawZone;
        if (!isGeneric && isValidZoneOrBarrioName(rawZone)) {
          try {
            const matched = await deliveryZones.findMatching(ctx.tenant.business.id, rawZone);
            if (!matched) {
              const capName = rawZone.charAt(0).toUpperCase() + rawZone.slice(1);
              await deliveryZones.upsertBatch(ctx.tenant.business.id, [
                {
                  name: capName,
                  price: input.flete_monto,
                  barrios: [rawZone.toLowerCase()],
                },
              ]);
              finalZoneName = capName;
            } else {
              finalZoneName = matched.name;
            }
          } catch {
            // continuar si ya existe o falla
          }
        }
        deliveryInput = {
          fee: input.flete_monto,
          zoneName: finalZoneName,
        };
      } else if (input.zona_envio) {
        const matched = await deliveryZones.findMatching(ctx.tenant.business.id, input.zona_envio);
        if (matched) {
          deliveryInput = {
            fee: matched.price,
            zoneName: matched.name,
          };
        }
      }

      const result = await sales.createSale(
        ctx.tenant.business.id,
        ctx.actorUserId,
        input.items.map((it) => ({
          name: it.nombre,
          quantity: it.cantidad,
          unitPrice: it.precio_unitario !== undefined && it.precio_unitario !== null ? Number(it.precio_unitario) : undefined,
        })),
        input.nota ?? undefined,
        ctx.now,
        ctx.tenant.business.timezone ?? 'America/Argentina/Buenos_Aires',
        customDate,
        deliveryInput
      );

      const receipt = formatSaleReceipt({
        saleId: result.sale.id,
        total: Number(result.sale.total),
        shiftDate: result.sale.shiftDate,
        createdAt: result.sale.createdAt,
        breakdown: result.pricing.breakdown,
        timezone: ctx.tenant.business.timezone,
        note: result.sale.note ?? undefined,
        foodTotal: result.pricing.foodTotal,
        deliveryFee: result.pricing.deliveryFee,
        deliveryZoneName: result.pricing.deliveryZoneName,
      });

      return {
        reply: receipt,
        audit: {
          action: 'sale.created',
          entityType: 'rotiseria_sale',
          entityId: result.sale.id,
          metadata: {
            total: Number(result.sale.total),
            items: result.pricing.lines.length,
            shiftDate: result.sale.shiftDate,
            deliveryFee: result.pricing.deliveryFee,
            deliveryZoneName: result.pricing.deliveryZoneName,
          },
        },
      };
    },
  };


  const anularVenta: ActionDef<AnularVenta> = {
    name: 'anular_venta',
    description:
      'Anula lógicamente una venta para corregir un error de caja. Despliega un menú interactivo con las últimas ventas o la última activa.',
    kind: 'read',
    input: AnularVentaInput,
    handler: async (ctx, input) => {
      if (input.sale_id) {
        const sale = await sales.findSaleById(input.sale_id, ctx.tenant.business.id);
        if (!sale) {
          throw new AppError(`No se encontró la venta con ID "${input.sale_id}".`);
        }
        const saleNum = formatSaleNumber(sale.id);
        const tz = ctx.tenant.business.timezone ?? 'America/Argentina/Buenos_Aires';
        const itemsList = sale.items.map((it) => `• ${formatQty(Number(it.quantity))}x ${esc(it.name)}`).join('\n');
        const text = [
          '⚠️ ¿Confirmás la anulación de esta venta?',
          '',
          `🆔 Venta #${saleNum}`,
          `📅 Fecha: ${formatRealDateWithDay(sale.shiftDate)} (${formatTimeOnly(sale.createdAt, tz)} hs)`,
          'Detalle:',
          itemsList || '• (Sin detalle)',
          `Total: *${formatCurrency(Number(sale.total))}*`,
        ].join('\n');

        return {
          reply: text,
          inlineKeyboard: [
            [{ text: '✅ Sí, anular venta', callbackData: `rotiseria:anular_confirmar:${sale.id}` }],
            [{ text: '❌ No, volver', callbackData: 'rotiseria:anular_cancelar' }],
          ],
        };
      }

      return {
        reply: '↩️ ¿Qué venta deseás anular?',
        inlineKeyboard: [
          [{ text: '↩️ Anular última venta', callbackData: 'rotiseria:anular_ultima' }],
          [
            { text: '📋 Últimas 5 ventas', callbackData: 'rotiseria:anular_listar:5' },
            { text: '📋 Últimas 10 ventas', callbackData: 'rotiseria:anular_listar:10' },
          ],
          [{ text: '❌ Cancelar', callbackData: 'rotiseria:anular_cancelar' }],
        ],
      };
    },
  };

  const cambiarPrecio: ActionDef<CambiarPrecio> = {
    name: 'cambiar_precio',
    description:
      'Modifica el precio de un producto o promo. Si no se especifican datos, abre el menú interactivo guiado por categorías.',
    kind: 'read',
    input: CambiarPrecioInput,
    handler: async (ctx, input) => {
      const businessId = ctx.tenant.business.id;

      // 1. Invocación de menú interactivo por categorías
      if (!input.nombre && !input.product_id) {
        const categories = await products.listActiveCategories(businessId);
        if (categories.length === 0) {
          return { reply: 'Todavía no hay productos cargados en la carta.' };
        }
        const rows: InlineButton[][] = [];
        let currentRow: InlineButton[] = [];
        for (const cat of categories) {
          const icon = getCategoryIcon(cat);
          const label = `${icon} ${cat.charAt(0).toUpperCase() + cat.slice(1)}`;
          currentRow.push({ text: label, callbackData: `rotiseria:price_cat:${cat}` });
          if (currentRow.length === 2) {
            rows.push(currentRow);
            currentRow = [];
          }
        }
        if (currentRow.length > 0) rows.push(currentRow);
        rows.push([{ text: '❌ Cancelar', callbackData: 'rotiseria:price_cancel' }]);

        return {
          reply: '🏷️ *Cambiar Precios*\n\nSeleccioná la categoría del producto que querés actualizar:',
          inlineKeyboard: rows,
        };
      }

      // 2. Modificación efectiva
      let product = input.product_id
        ? await products.findProductById(input.product_id, businessId)
        : null;

      if (!product && input.nombre) {
        product = await products.findProductByName(businessId, input.nombre);
      }

      if (product) {
        const updated = await products.updateProduct(product.id, businessId, {
          priceUnit: input.precio_unitario,
          priceDozen: input.precio_docena,
          priceHalfDozen: input.precio_media_docena,
        });
        const halfText = updated.priceHalfDozen ? ` (Media docena: *${formatCurrency(Number(updated.priceHalfDozen))}*)` : '';
        const docenaText = updated.priceDozen ? ` (Docena: *${formatCurrency(Number(updated.priceDozen))}*)` : '';
        return {
          reply: `✅ Precio de *${esc(updated.name)}* actualizado a *${formatCurrency(Number(updated.priceUnit))}*${halfText}${docenaText}.`,
          audit: {
            action: 'product.price_updated',
            entityType: 'rotiseria_product',
            entityId: updated.id,
            metadata: {
              priceUnit: Number(updated.priceUnit),
              priceDozen: updated.priceDozen ? Number(updated.priceDozen) : null,
            },
          },
        };
      }

      if (input.nombre) {
        const promo = await products.findPromoByName(businessId, input.nombre);
        if (promo && input.precio_unitario) {
          const updated = await products.updatePromo(promo.id, businessId, {
            price: input.precio_unitario,
          });
          return {
            reply: `✅ Precio de *${esc(updated.name)}* actualizado a *${formatCurrency(Number(updated.price))}*.`,
            audit: {
              action: 'promo.price_updated',
              entityType: 'rotiseria_promo',
              entityId: updated.id,
              metadata: { price: Number(updated.price) },
            },
          };
        }
      }

      throw new AppError(`No encontré ningún producto o promo.`);
    },
  };

  const controlDias: ActionDef<ControlDias> = {
    name: 'control_dias',
    description: 'Consulta el control de turnos recientes (panel semáforo de los últimos 7 días) o detalle de una fecha.',
    kind: 'read',
    input: ControlDiasInput,
    handler: async (ctx, input) => {
      if (ctx.tenant.membership.role !== 'OWNER') {
        return {
          reply: '⛔ Esta función está reservada únicamente para el dueño del negocio.',
        };
      }

      const tz = ctx.tenant.business.timezone ?? 'America/Argentina/Buenos_Aires';

      if (input.fecha) {
        let targetDate: Date | undefined;
        const clean = input.fecha.toLowerCase().trim();
        if (clean === 'ayer' || clean === 'anoche') {
          targetDate = new Date();
          targetDate.setUTCDate(targetDate.getUTCDate() - 1);
        } else if (clean !== 'hoy') {
          const parsed = new Date(input.fecha.includes('T') ? input.fecha : `${input.fecha}T12:00:00Z`);
          if (!isNaN(parsed.getTime())) {
            targetDate = parsed;
          }
        }

        const s = await sales.getDaySummary(ctx.tenant.business.id, targetDate, ctx.now, tz);
        const lines = [
          `📅 *Control de días — ${s.shiftDateStr}*`,
          '',
          `🛒 Ventas: *${formatCurrency(s.salesTotal)}* (${s.salesCount} pedido${s.salesCount !== 1 ? 's' : ''})`,
          s.cancelledCount > 0 ? `↩️ Anuladas: ${s.cancelledCount} (*${formatCurrency(s.cancelledTotal)}*)` : '',
        ].filter(Boolean);

        if (s.topProducts.length > 0) {
          lines.push('', '🔥 *Más vendidos del turno:*');
          for (const p of s.topProducts.slice(0, 5)) {
            lines.push(`• ${esc(p.name)}: *${formatQty(p.quantity)}* (${formatCurrency(p.subtotal)})`);
          }
        }

        return { reply: lines.join('\n') };
      }

      // Semáforo últimos 7 turnos
      const shifts = await sales.getRecentShiftsSummary(ctx.tenant.business.id, ctx.now, 7, tz);
      const lines = ['📅 *Control de días recientes (Últimos 7 turnos):*', ''];
      const buttons: InlineButton[][] = [];

      for (const day of shifts) {
        if (day.count > 0) {
          lines.push(`🟢 ${formatRealDateWithDay(day.date)}: ${day.count} ventas — *${formatCurrency(day.total)}*`);
          buttons.push([
            { text: `🔍 Ver ${formatDateOnly(day.date)}`, callbackData: `rotiseria:ver_dia:${day.dateStr}` },
          ]);
        } else {
          lines.push(`⚪ ${formatRealDateWithDay(day.date)}: Sin ventas registradas`);
        }
      }

      buttons.push([{ text: '❌ Cerrar', callbackData: 'rotiseria:cerrar' }]);
      return { reply: lines.join('\n'), inlineKeyboard: buttons };
    },
  };

  const consultarEstadisticas: ActionDef<ConsultarEstadisticas> = {
    name: 'consultar_estadisticas',
    description: 'Muestra estadísticas generales: facturación neta, ticket promedio y productos más vendidos. Dato opcional: periodo (esta_semana, semana_cerrada, este_mes, historico).',
    kind: 'read',
    input: ConsultarEstadisticasInput,
    handler: async (ctx, input) => {
      if (ctx.tenant.membership.role !== 'OWNER') {
        return {
          reply: '⛔ Esta función está reservada únicamente para el dueño del negocio.',
        };
      }

      const stats = await sales.getStatsSummary(ctx.tenant.business.id, input.periodo, ctx.now);

      const lines: string[] = [
        `📈 *Estadísticas — ${esc(stats.periodLabel)}*`,
        '',
        `💰 Total facturado: *${formatCurrency(stats.salesTotal)}*`,
        `🧾 Cantidad de ventas: *${stats.salesCount}* pedidos`,
        ...(stats.cancelledCount > 0 ? [`↩️ Pedidos anulados: *${stats.cancelledCount}*`] : []),
      ];

      if (stats.top3Products.length > 0) {
        lines.push('', '', '🏆 *Top 3 productos más vendidos:*');
        for (const p of stats.top3Products) {
          lines.push(`• ${esc(p.name)}: *${formatQty(p.quantity)}* u. — *${formatCurrency(p.subtotal)}*`);
        }
      }

      if (stats.categories.length > 0) {
        lines.push('', '', '📊 *Desglose por categorías:*');
        for (const c of stats.categories) {
          lines.push(`• ${getCategoryIcon(c.category)} *${esc(c.category)}*: ${formatQty(c.quantity)} u. — *${formatCurrency(c.subtotal)}*`);
        }
      }

      if (stats.promosSummary && stats.promosSummary.promos.length > 0) {
        lines.push('', '🎁 *Promos vendidas:*');
        for (const pr of stats.promosSummary.promos) {
          lines.push(`• *${esc(pr.name)}*: ${formatQty(pr.quantity)} u. — *${formatCurrency(pr.subtotal)}*`);
        }
        lines.push(`Total combos: *${formatQty(stats.promosSummary.totalQuantity)}* u. (*${formatCurrency(stats.promosSummary.totalAmount)}*)`);
      }

      if (stats.drinksSummary && stats.drinksSummary.totalQuantity > 0) {
        lines.push('', '🥤 *Bebidas vendidas:*');
        lines.push(
          `Total: *${formatQty(stats.drinksSummary.totalQuantity)}* u. (*${formatCurrency(stats.drinksSummary.totalAmount)}*)`
        );
        if (stats.drinksSummary.topDrink) {
          lines.push(
            `Más vendida: 🥇 *${esc(stats.drinksSummary.topDrink.name)}* (*${formatQty(stats.drinksSummary.topDrink.quantity)}* u. — *${formatCurrency(stats.drinksSummary.topDrink.subtotal)}*)`
          );
        }
      }

      const buttons: InlineButton[][] = [];
      const periodParam = input.periodo || 'esta_semana';
      if (stats.drinksSummary && stats.drinksSummary.totalQuantity > 0) {
        buttons.push([
          { text: '🥤 Detalle de bebidas', callbackData: `rotiseria:stats_bebidas:${periodParam}` },
          { text: '🔍 Por categoría', callbackData: `rotiseria:catmenu:${periodParam}` },
        ]);
      } else {
        buttons.push([
          { text: '🔍 Ver productos por categoría', callbackData: `rotiseria:catmenu:${periodParam}` },
        ]);
      }
      buttons.push([{ text: '🔄 Cambiar período', callbackData: 'rotiseria:stats_menu' }]);

      return { reply: lines.join('\n'), inlineKeyboard: buttons };
    },
  };

  const menuEstadisticas: ActionDef<Empty> = {
    name: 'menu_estadisticas',
    description: 'Menú interactivo de estadísticas de la rotisería por períodos.',
    kind: 'read',
    input: EmptyInput,
    handler: async (ctx) => {
      if (ctx.tenant.membership.role !== 'OWNER') {
        return {
          reply: '⛔ Esta función está reservada únicamente para el dueño del negocio.',
        };
      }

      return {
        reply: '📈 *Estadísticas del Negocio*\n\nSeleccioná el período que querés consultar:',
        inlineKeyboard: [
          [
            { text: '📅 Últimos 7 días', callbackData: 'rotiseria:stats:esta_semana' },
            { text: '🗓️ Semana (Lun a Dom)', callbackData: 'rotiseria:stats:semana_cerrada' },
          ],
          [
            { text: '📆 Este mes', callbackData: 'rotiseria:stats:este_mes' },
            { text: '📈 Histórico', callbackData: 'rotiseria:stats:historico' },
          ],
          [
            { text: '🗂️ Otro mes', callbackData: 'rotiseria:stats_ask_month' },
          ],
        ],
      };
    },
  };

  const crearProducto: ActionDef<CrearProducto> = {
    name: 'crear_producto',
    description:
      'Crea un nuevo producto en la rotisería. Datos: nombre, precio_unitario, precio_media_docena (opcional), precio_docena (opcional), categoria (opcional, ej. "empanadas", "pizzas", "sandwiches").',
    kind: 'write',
    input: CrearProductoInput,
    intro: [
      '📦 *Crear Comida o Producto*',
      '',
      'Mandá un mensaje o audio indicando el nombre y los precios.',
      '',
      '💡 *Tip de precios:*',
      'Podés cargar:',
      '• *Con 3 precios (unidad, media docena y docena):*',
      '  👉 *"Empanada de Carne 1500, media docena 8000, docena 15000"*',
      '• *Con 2 precios (unidad y docena):*',
      '  👉 *"Empanada de Jamón y Queso 1500, docena 15000"*',
      '  _(la media docena se liquidará por unidad automáticamente)_',
      '• *Solo precio unitario:*',
      '  👉 *"Pizza Muzzarella 8500"* o *"Sándwich de Milanesa 6500"*',
    ].join('\n'),
    fieldPrompts: {
      nombre: '¿Cómo se llama el producto? (ej: "Empanada de Pollo" o "Pizza Especial")',
      precio_unitario: '¿Precio unitario por unidad? (ej: "1500")',
    },
    summarize: (i) =>
      [
        'Entendí el producto:',
        '',
        `📦 *${esc(i.nombre)}*`,
        `• Precio unitario: *${formatCurrency(i.precio_unitario)}*`,
        i.precio_media_docena ? `• Media docena: *${formatCurrency(i.precio_media_docena)}*` : '',
        i.precio_docena ? `• Precio docena: *${formatCurrency(i.precio_docena)}*` : '',
        `• Categoría: *${esc(i.categoria)}*`,
        '\n¿Confirmar creación?',
      ]
        .filter(Boolean)
        .join('\n'),
    handler: async (ctx, input) => {
      const p = await products.createProduct({
        businessId: ctx.tenant.business.id,
        name: input.nombre,
        priceUnit: input.precio_unitario,
        priceDozen: input.precio_docena,
        priceHalfDozen: input.precio_media_docena,
        category: input.categoria,
      });

      const halfStr = p.priceHalfDozen ? ` (media docena ${formatCurrency(Number(p.priceHalfDozen))})` : '';
      const dozenStr = p.priceDozen ? ` (docena ${formatCurrency(Number(p.priceDozen))})` : '';

      return {
        reply: `✅ Creado *${esc(p.name)}* a ${formatCurrency(Number(p.priceUnit))}${halfStr}${dozenStr}.`,
        audit: {
          action: 'product.created',
          entityType: 'rotiseria_product',
          entityId: p.id,
          metadata: { name: p.name, priceUnit: Number(p.priceUnit) },
        },
      };
    },
  };

  const crearPromo: ActionDef<CrearPromo> = {
    name: 'crear_promo',
    description:
      'Crea una nueva promoción fija con precio cerrado. Datos: nombre, precio, descripcion (opcional).',
    kind: 'write',
    input: CrearPromoInput,
    intro: [
      '🎁 *Crear Promoción*',
      '',
      'Mandá un mensaje o audio indicando el nombre de la promo, su precio y qué incluye.',
      '',
      '💡 *Tip de formato:*',
      '• *"Promo 1 a 16000: Muzza + 6 empanadas de carne"*',
      '• *"Promo Pareja 12000: 2 Sándwiches de Milanesa con papas"*',
      '• O separando con barra: *"Promo 3 | 18500 | 1 Pizza Especial + 6 Empanadas"*',
    ].join('\n'),
    fieldPrompts: {
      nombre: '¿Cómo se llama la promo? (ej: "Promo 1" o "Combo Familiar")',
      precio: '¿Cuál es el precio total de la promo? (ej: "16000")',
    },
    summarize: (i) =>
      [
        'Entendí la promo:',
        '',
        `🎁 *${esc(i.nombre)}*`,
        `• Precio: *${formatCurrency(i.precio)}*`,
        i.descripcion ? `• Detalle: ${esc(i.descripcion)}` : '',
        '\n¿Confirmar creación?',
      ]
        .filter(Boolean)
        .join('\n'),
    handler: async (ctx, input) => {
      const pr = await products.createPromo({
        businessId: ctx.tenant.business.id,
        name: input.nombre,
        price: input.precio,
        description: input.descripcion,
      });

      return {
        reply: `✅ Promo *${esc(pr.name)}* creada por ${formatCurrency(Number(pr.price))}.`,
        audit: {
          action: 'promo.created',
          entityType: 'rotiseria_promo',
          entityId: pr.id,
          metadata: { name: pr.name, price: Number(pr.price) },
        },
      };
    },
  };

  const crearEditarPromo: ActionDef<CrearEditarPromo> = {
    name: 'crear_editar_promo',
    description:
      'Gestión integral de promociones de la rotisería: crear nuevos combos/promos, modificar precios, descripciones o pausar/activar.',
    kind: 'read',
    input: CrearEditarPromoInput,
    handler: async (ctx, input) => {
      const businessId = ctx.tenant.business.id;

      // 1. Modificación directa si viene promo_id
      if (input.promo_id) {
        const promo = await products.findPromoById(input.promo_id, businessId);
        if (!promo) {
          throw new AppError('Promo no encontrada.');
        }
        if (input.precio !== undefined) {
          const updated = await products.updatePromo(promo.id, businessId, { price: input.precio });
          return {
            reply: `✅ Precio de *${esc(updated.name)}* actualizado a *${formatCurrency(Number(updated.price))}*.`,
            audit: {
              action: 'promo.price_updated',
              entityType: 'rotiseria_promo',
              entityId: updated.id,
              metadata: { price: Number(updated.price) },
            },
          };
        }
        if (input.descripcion !== undefined) {
          const updated = await products.updatePromo(promo.id, businessId, { description: input.descripcion });
          return {
            reply: `✅ Descripción de *${esc(updated.name)}* actualizada: ${updated.description ? `_${esc(updated.description)}_` : '_(Sin descripción)_'}.`,
            audit: {
              action: 'promo.updated',
              entityType: 'rotiseria_promo',
              entityId: updated.id,
              metadata: { description: updated.description },
            },
          };
        }
      }

      // 2. Creación directa si viene nombre y precio
      if (input.nombre && input.precio) {
        const created = await products.createPromo({
          businessId,
          name: input.nombre,
          price: input.precio,
          description: input.descripcion,
        });
        return {
          reply: `✅ Promo *${esc(created.name)}* creada por *${formatCurrency(Number(created.price))}*.`,
          audit: {
            action: 'promo.created',
            entityType: 'rotiseria_promo',
            entityId: created.id,
            metadata: { name: created.name, price: Number(created.price) },
          },
        };
      }

      // 3. Menú interactivo de gestión de promos
      const promoList = await products.listPromos(businessId, { includeInactive: true });
      const rows: InlineButton[][] = [
        [{ text: '➕ Crear nueva promo', callbackData: 'rotiseria:promo:nueva' }],
      ];

      for (const pr of promoList) {
        const statusIcon = pr.isActive ? '🟢' : '⏸️';
        rows.push([
          {
            text: `${statusIcon} ${pr.name} (${formatCurrency(Number(pr.price))})`,
            callbackData: `rotiseria:promo:editar:${pr.id}`,
          },
        ]);
      }

      rows.push([{ text: '❌ Cancelar', callbackData: 'rotiseria:promo:cancelar' }]);

      return {
        reply: '🎁 *Gestión de Promociones*\n\nSeleccioná una promo para editar o creá una nueva:',
        inlineKeyboard: rows,
      };
    },
  };

  const consultarCartaHandler = async (
    ctx: ActionContext,
    input: { categoria?: string }
  ) => {
    const [productList, promoList] = await Promise.all([
      products.listProducts(ctx.tenant.business.id, { category: input.categoria, limit: 100 }),
      products.listPromos(ctx.tenant.business.id),
    ]);

    if (productList.length === 0 && promoList.length === 0) {
      return {
        reply:
          'Todavía no tenés comidas ni promos cargadas.\nPodés crear una escribiendo *"Crear empanada de carne a 1500, docena 15000"*.',
      };
    }

    const lines: string[] = ['📋 *Carta y Precios:*', ''];

    if (promoList.length > 0 && !input.categoria) {
      lines.push('🎁 *Promociones:*');
      for (const pr of promoList) {
        const desc = pr.description ? ` _(${esc(pr.description)})_` : '';
        lines.push(`• *${esc(pr.name)}*: *${formatCurrency(Number(pr.price))}*${desc}`);
      }
      lines.push('');
    }

    const byCat = new Map<string, typeof productList>();
    for (const p of productList) {
      const cat = p.category || 'general';
      const arr = byCat.get(cat) ?? [];
      arr.push(p);
      byCat.set(cat, arr);
    }

    for (const [cat, prods] of byCat.entries()) {
      const icon = getCategoryIcon(cat);
      lines.push(`${icon} *${esc(cat.toUpperCase())}:*`);
      for (const p of prods) {
        const docena = p.priceDozen ? ` (Docena: *${formatCurrency(Number(p.priceDozen))}*)` : '';
        lines.push(`• ${esc(p.name)}: *${formatCurrency(Number(p.priceUnit))}*${docena}`);
      }
      lines.push('');
    }

    return { reply: lines.join('\n') };
  };

  const consultarCarta: ActionDef<ConsultarMenu> = {
    name: 'consultar_carta',
    description: 'Muestra el listado de platos, empanadas, pizzas y promociones vigentes de la carta. Dato opcional: categoria.',
    kind: 'read',
    input: ConsultarMenuInput,
    handler: consultarCartaHandler,
  };

  const consultarMenu: ActionDef<ConsultarMenu> = {
    name: 'consultar_menu',
    description: 'Muestra la lista de comidas, empanadas, pizzas y promos con sus precios vigentes. Dato opcional: categoria.',
    kind: 'read',
    input: ConsultarMenuInput,
    handler: consultarCartaHandler,
  };

  const mostrarMenu: ActionDef<Empty> = {
    name: 'mostrar_menu',
    description: 'Muestra las funcionalidades disponibles y guía rápida de uso del bot.',
    kind: 'read',
    input: EmptyInput,
    handler: async (ctx) => ({
      reply: ctx.tenant?.membership?.role === 'EMPLOYEE' ? ROTISERIA_MENU_HELP_TEXT_EMPLOYEE : ROTISERIA_MENU_HELP_TEXT,
    }),
  };

  const consultarVentas: ActionDef<HistorialVentas> = {
    name: 'consultar_ventas',
    description: 'Muestra las últimas ventas registradas con su estado y detalle. Dato opcional: limite (1-20).',
    kind: 'read',
    input: HistorialVentasInput,
    handler: async (ctx, input) => {
      const limit = input.limite || 5;
      const recent = await sales.listRecentSales(ctx.tenant.business.id, limit);
      if (recent.length === 0) {
        return { reply: 'Todavía no hay ventas registradas.' };
      }

      const tz = ctx.tenant.business.timezone ?? 'America/Argentina/Buenos_Aires';
      const blocks = recent.map((sale) => {
        const num = formatSaleNumber(sale.id);
        const status = sale.isCancelled ? ' ❌ *[ANULADA]*' : '';
        const items = sale.items.map((it) => `  • ${formatQty(Number(it.quantity))}x ${esc(it.name)}`).join('\n');
        return `🛒 *Venta #${num}* (*${formatCurrency(Number(sale.total))}*) — _${formatRealDateWithDay(sale.shiftDate)}_ (${formatTimeOnly(sale.createdAt, tz)} hs)${status}\n${items}`;
      });

      const buttons: InlineButton[][] = [
        [
          limit === 5
            ? { text: '📄 Ver últimas 10 ventas', callbackData: 'rotiseria:historial:10' }
            : { text: '📄 Ver últimas 5 ventas', callbackData: 'rotiseria:historial:5' },
          { text: '❌ Cerrar', callbackData: 'rotiseria:historial:cerrar' },
        ],
      ];

      return {
        reply: [`🧾 *Últimas ${recent.length} ventas:*`, '', ...blocks].join('\n'),
        inlineKeyboard: buttons,
      };
    },
  };

  const gestionarEnvios: ActionDef<GestionarEnvios> = {
    name: 'gestionar_envios',
    description: '🛵 Envíos a domicilio y tarifas.',
    kind: 'read',
    input: GestionarEnviosInput,
    handler: async (ctx, input) => {
      const businessId = ctx.tenant.business.id;

      if (input.zone_id && input.nuevo_precio !== undefined) {
        const updated = await deliveryZones.updateZonePrice(
          input.zone_id,
          businessId,
          input.nuevo_precio
        );
        const feeStr = updated.price === 0 ? '¡GRATIS! ($0)' : formatCurrency(updated.price);
        return {
          reply: `✅ Precio de la zona *${esc(updated.name)}* actualizado a *${feeStr}*.`,
          audit: {
            action: 'delivery_zone.price_updated',
            entityType: 'rotiseria_delivery_zone',
            entityId: updated.id,
            metadata: { name: updated.name, price: updated.price },
          },
          inlineKeyboard: [
            [{ text: '↩️ Volver a Envíos', callbackData: 'rotiseria:envios_menu' }],
          ],
        };
      }

      const zones = await deliveryZones.listActive(businessId);
      const lines: string[] = ['🛵 *Zonas y Tarifas de Envíos*', ''];

      if (zones.length === 0) {
        lines.push('Todavía no tenés zonas de envío configuradas.');
        lines.push('Podés cargarlas rápidamente agrupando barrios por precio o mandando un audio.');
      } else {
        for (const z of zones) {
          const feeStr = z.price === 0 ? '¡GRATIS! ($0)' : formatCurrency(z.price);
          lines.push(`• *${esc(z.name)}* — ${feeStr}`);
          if (z.barrios.length > 0) {
            const capitalizedBarrios = z.barrios
              .map((b) => b.charAt(0).toUpperCase() + b.slice(1))
              .join(', ');
            lines.push(`  Barrios: ${esc(capitalizedBarrios)}`);
          }
        }
      }

      lines.push('');
      lines.push('Seleccioná una opción para modificar o consultar:');

      return {
        reply: lines.join('\n'),
        inlineKeyboard: [
          [{ text: '➕ Cargar por lote (audio/texto)', callbackData: 'rotiseria:envios_lote_guia' }],
          [{ text: '🏷️ Cambiar precio de una zona', callbackData: 'rotiseria:envios_cambiar_precio' }],
          [{ text: '🗑️ Eliminar zona', callbackData: 'rotiseria:zonas_listar_borrar' }],
          [{ text: '📊 Zonas con más movimiento', callbackData: 'rotiseria:envios_stats' }],
        ],
      };
    },
  };

  const configurarEnviosLote: ActionDef<ConfigurarEnviosLote> = {
    name: 'configurar_envios_lote',
    description: 'Configura o actualiza en lote las zonas de envío, precios y barrios asociados.',
    kind: 'write',
    input: ConfigurarEnviosLoteInput,
    summarize: (input) => {
      if (!input.zonas || input.zonas.length === 0) {
        return '⚠️ No pude detectar zonas ni precios válidos en el mensaje. Probá con: "Centro 1500, San Lorenzo 2500".';
      }
      const lines = input.zonas.map((z) => {
        const precioStr = z.precio === 0 ? '¡GRATIS! ($0)' : `$ ${new Intl.NumberFormat('es-AR').format(z.precio)}`;
        const barriosStr = z.barrios && z.barrios.length > 0 ? ` [${z.barrios.join(', ')}]` : '';
        return `• *${z.nombre}*: *${precioStr}*${barriosStr}`;
      });
      return [
        '🛵 *Zonas y tarifas detectadas:*',
        '',
        ...lines,
        '',
        '¿Confirmás guardar estas zonas?',
      ].join('\n');
    },
    handler: async (ctx, input) => {
      const updated = await deliveryZones.upsertBatch(
        ctx.tenant.business.id,
        input.zonas.map((z) => ({
          name: z.nombre,
          price: z.precio,
          barrios: z.barrios,
        }))
      );

      const lines = [
        `✅ *Se configuraron ${updated.length} zonas de envío:*`,
        '',
      ];
      for (const z of updated) {
        const feeStr = z.price === 0 ? '¡GRATIS! ($0)' : formatCurrency(z.price);
        const barriosInfo = z.barrios.length > 0 ? ` (${z.barrios.length} barrios)` : '';
        lines.push(`• *${esc(z.name)}*: ${feeStr}${barriosInfo}`);
      }

      return {
        reply: lines.join('\n'),
        audit: {
          action: 'delivery_zone.batch_configured',
          entityType: 'rotiseria_delivery_zone',
          metadata: { count: updated.length },
        },
      };
    },
  };

  const gestionarBebidas: ActionDef<GestionarBebidas> = {
    name: 'gestionar_bebidas',
    description: '🥤 Bebidas disponibles y gestión de precios / carta de bebidas.',
    kind: 'read',
    input: GestionarBebidasInput,
    handler: async (ctx, input) => {
      const businessId = ctx.tenant.business.id;

      if (input.product_id && input.nuevo_precio !== undefined) {
        const prod = await products.findProductById(input.product_id, businessId);
        if (!prod) {
          throw new AppError('Bebida no encontrada.');
        }
        const updated = await products.updateProduct(prod.id, businessId, {
          priceUnit: input.nuevo_precio,
        });
        return {
          reply: `✅ Precio de *${esc(updated.name)}* actualizado a *${formatCurrency(Number(updated.priceUnit))}*.`,
          audit: {
            action: 'drink.price_updated',
            entityType: 'rotiseria_product',
            entityId: updated.id,
            metadata: { name: updated.name, price: Number(updated.priceUnit) },
          },
          inlineKeyboard: [
            [{ text: '↩️ Volver a Bebidas', callbackData: 'rotiseria:bebidas_menu' }],
          ],
        };
      }

      const drinks = await products.listProducts(businessId, { category: 'bebidas', limit: 100 });
      const lines: string[] = ['🥤 *Bebidas Disponibles:*', ''];

      if (drinks.length === 0) {
        lines.push('Todavía no tenés bebidas cargadas.');
        lines.push('Podés cargarlas rápidamente escribiendo o mandando un audio (ej: *"Coca 1.5L 3500, Fanta 1.5L 3500, Cerveza 1L 4000"*).');
      } else {
        for (const d of drinks) {
          lines.push(`• *${esc(d.name)}* — *${formatCurrency(Number(d.priceUnit))}*`);
        }
      }

      return {
        reply: lines.join('\n'),
        inlineKeyboard: [
          [{ text: '➕ Cargar bebidas por lote', callbackData: 'rotiseria:bebidas_lote' }],
          [{ text: '💵 Modificar precio', callbackData: 'rotiseria:bebidas_precio' }],
          [{ text: '🗑️ Eliminar / Desactivar bebida', callbackData: 'rotiseria:bebidas_borrar' }],
        ],
      };
    },
  };

  const configurarBebidasLote: ActionDef<ConfigurarBebidasLote> = {
    name: 'configurar_bebidas_lote',
    description: 'Carga o actualiza en lote la lista de bebidas y sus precios.',
    kind: 'write',
    input: ConfigurarBebidasLoteInput,
    intro: [
      '🥤 *Carga de Bebidas*',
      '',
      'Mandá un audio o mensaje indicando marca, tamaño y precio.',
      '',
      '💡 *Tip de formato:*',
      "Usá punto y 'L' para litros, o 'ml' para envases chicos:",
      '• *"Coca-Cola 1.5L 3500"*',
      '• *"Sprite 2.25L 4200"*',
      '• *"Agua 500ml 1800"*',
      '• *"Cerveza Quilmes 1L 4000"*',
    ].join('\n'),
    handler: async (ctx, input) => {
      const updated = await products.upsertBatchBebidas(
        ctx.tenant.business.id,
        input.bebidas.map((b) => ({
          nombre: b.nombre,
          precio: b.precio,
        }))
      );

      const lines = [
        `✅ *Se configuraron ${updated.length} bebidas:*`,
        '',
      ];
      for (const b of updated) {
        lines.push(`• *${esc(b.name)}*: *${formatCurrency(Number(b.priceUnit))}*`);
      }

      return {
        reply: lines.join('\n'),
        audit: {
          action: 'drink.batch_configured',
          entityType: 'rotiseria_product',
          metadata: { count: updated.length },
        },
      };
    },
  };

  return [
    registrarVenta,
    controlDias,
    consultarEstadisticas,
    menuEstadisticas,
    anularVenta,
    cambiarPrecio,
    crearProducto,
    crearPromo,
    crearEditarPromo,
    consultarCarta,
    consultarMenu,
    mostrarMenu,
    consultarVentas,
    gestionarEnvios,
    configurarEnviosLote,
    gestionarBebidas,
    configurarBebidasLote,
  ] as unknown as ActionDef<unknown>[];
}

export const ROTISERIA_MENU_HELP_TEXT = [
  '✨ *¿Qué podemos hacer juntos?*',
  '',
  'Acá tenés a mano todo lo que podés pedirme en el día a día para que no tengas que hacer cuentas en la cabeza:',
  '',
  '🥟 *Ventas y pedidos:*',
  '• Mandame un audio o mensaje con el pedido del cliente y te saco el total al toque (calculando docenas y promos solo).',
  '• /ventas — Para mirar los últimos pedidos que fuimos cobrando.',
  '• /anular — Por si hubo una equivocación y necesitás cancelar una venta.',
  '',
  '🛵 *Envíos a domicilio:*',
  '• /envios — Para configurar o ver los precios por barrio o zona de delivery.',
  '',
  '📋 *Tu carta:*',
  '• /catalogo — Para ver el catálogo completo, activar/desactivar o cambiar categorías.',
  '• /producto_nuevo — Alta guiada paso a paso de un nuevo producto.',
  '• /carta — Para ver las comidas y promos con sus precios actuales.',
  '• /precio — Para actualizar los precios rápido.',
  '• /comida — Para sumar un plato o producto nuevo.',
  '• /promo — Para armar combos especiales.',
  '• /bebidas — Para consultar bebidas y refrescos.',
  '',
  '📊 *Cuentas y números:*',
  '• /dias — Para ver cómo viene el turno o el cierre de anoche.',
  '• /stats — Para ver cuánto se vendió en la semana y qué fue lo que más salió.',
  '',
  '👇 *Tip:* Para lo más importante del día a día, tenés los botones rápidos acá abajo en la pantalla sin tener que escribir nada.',
].join('\n');

export const ROTISERIA_MENU_HELP_TEXT_EMPLOYEE = [
  '✨ *¿Qué podemos hacer juntos?*',
  '',
  'Acá tenés a mano todo lo que podés pedirme en el día a día para que no tengas que hacer cuentas en la cabeza:',
  '',
  '🥟 *Ventas y pedidos:*',
  '• Mandame un audio o mensaje con el pedido del cliente y te saco el total al toque (calculando docenas y promos solo).',
  '• /ventas — Para mirar los últimos pedidos que fuimos cobrando.',
  '• /anular — Por si hubo una equivocación y necesitás cancelar una venta.',
  '',
  '🛵 *Envíos a domicilio:*',
  '• /envios — Para configurar o ver los precios por barrio o zona de delivery.',
  '',
  '📋 *Tu carta:*',
  '• /carta — Para ver las comidas y promos con sus precios actuales.',
  '• /precio — Para actualizar los precios rápido.',
  '• /comida — Para sumar un plato o producto nuevo.',
  '• /promo — Para armar combos especiales.',
  '• /bebidas — Para consultar bebidas y refrescos.',
  '',
  '👇 *Tip:* Para lo más importante del día a día, tenés los botones rápidos acá abajo en la pantalla sin tener que escribir nada.',
].join('\n');

export type { ActionContext };

