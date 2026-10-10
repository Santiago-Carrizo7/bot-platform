import type { ActionDef, ActionContext, InlineButton } from '../../core/actions/registry.js';
import type { ProductService } from './domain/product.service.js';
import type { SaleService } from './domain/sale.service.js';
import {
  AnularVentaInput,
  CambiarPrecioInput,
  ConsultarEstadisticasInput,
  ConsultarMenuInput,
  ControlDiasInput,
  CrearProductoInput,
  CrearPromoInput,
  EmptyInput,
  HistorialVentasInput,
  RegistrarVentaInput,
  type AnularVentaInput as AnularVenta,
  type CambiarPrecioInput as CambiarPrecio,
  type ConsultarEstadisticasInput as ConsultarEstadisticas,
  type ConsultarMenuInput as ConsultarMenu,
  type ControlDiasInput as ControlDias,
  type CrearProductoInput as CrearProducto,
  type CrearPromoInput as CrearPromo,
  type EmptyInput as Empty,
  type HistorialVentasInput as HistorialVentas,
  type RegistrarVentaInput as RegistrarVenta,
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
}

export function buildRotiseriaActions(deps: RotiseriaActionDeps): ActionDef<unknown>[] {
  const { products, sales } = deps;

  const registrarVenta: ActionDef<RegistrarVenta> = {
    name: 'registrar_venta',
    description:
      'Registra una venta de rotisería con empanadas, pizzas, sándwiches o promos. Datos: items (lista de {nombre, cantidad}), nota (opcional), fecha (opcional, YYYY-MM-DD). El total y docenas los calcula automáticamente el sistema.',
    kind: 'write',
    input: RegistrarVentaInput,
    intro:
      'Para registrar una venta decime qué y cuánto. Ejemplo: *"1 docena de carne y una muzza"* o *"8 empanadas de carne y 4 de pollo"*.',
    fieldPrompts: {
      items: '¿Qué se vendió? Decime productos y cantidades, por ejemplo: *"1 docena de carne y 1 pizza"*',
      nombre: '¿Qué producto o promo?',
      cantidad: '¿Qué cantidad?',
    },
    confirmButtons: () => [
      [
        { text: '✅ Confirmar venta', callbackData: 'confirm:yes' },
        { text: '❌ Cancelar', callbackData: 'confirm:no' },
      ],
      [
        { text: '✏️ Modificar pedido', callbackData: 'rotiseria:modificar' },
        { text: '📅 Cambiar fecha', callbackData: 'rotiseria:fecha' },
      ],
    ],
    summarize: async (i: any, ctx?: ActionContext) => {
      const items = Array.isArray(i.items) ? i.items : [];
      let breakdown: string[] | undefined;
      let total: number | undefined;

      if (ctx && items.length > 0) {
        try {
          const catalog = await products.getCatalogLookup(ctx.tenant.business.id);
          const pricing = calculatePricing(
            items.map((it: any) => ({ name: it.nombre, quantity: it.cantidad })),
            catalog
          );
          breakdown = pricing.breakdown;
          total = pricing.total;
        } catch {
          // Si el catálogo falla o producto no existe, fallback a lista limpia
        }
      }

      const noReconocidos = Array.isArray(i.no_reconocidos)
        ? i.no_reconocidos.map((x: any) => String(x.texto ?? x))
        : undefined;

      return formatSaleSummary({
        items,
        nota: i.nota,
        fecha: i.fecha,
        breakdown,
        total,
        isModifying: Boolean(i._modifying),
        now: ctx?.now,
        timezone: ctx?.tenant.business.timezone,
        noReconocidos,
      });
    },
    handler: async (ctx, input) => {
      let customDate: Date | undefined;
      if (input.fecha) {
        const d = new Date(input.fecha.includes('T') ? input.fecha : `${input.fecha}T12:00:00Z`);
        if (!isNaN(d.getTime())) customDate = d;
      }

      const result = await sales.createSale(
        ctx.tenant.business.id,
        ctx.actorUserId,
        input.items.map((it) => ({ name: it.nombre, quantity: it.cantidad })),
        input.nota,
        ctx.now,
        ctx.tenant.business.timezone ?? 'America/Argentina/Buenos_Aires',
        customDate
      );

      const receipt = formatSaleReceipt({
        saleId: result.sale.id,
        total: Number(result.sale.total),
        shiftDate: result.sale.shiftDate,
        createdAt: result.sale.createdAt,
        breakdown: result.pricing.breakdown,
        timezone: ctx.tenant.business.timezone,
        note: result.sale.note ?? undefined,
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
          [{ text: '📋 Elegir de las últimas 5 ventas', callbackData: 'rotiseria:anular_listar' }],
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
        });
        const docenaText = updated.priceDozen ? ` (Docena: *${formatCurrency(Number(updated.priceDozen))}*)` : '';
        return {
          reply: `✅ Precio de *${esc(updated.name)}* actualizado a *${formatCurrency(Number(updated.priceUnit))}*${docenaText}.`,
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
      const stats = await sales.getStatsSummary(ctx.tenant.business.id, input.periodo, ctx.now);

      const lines = [
        `📈 *Estadísticas — ${esc(stats.periodLabel)}*`,
        '',
        `💰 Total facturado: *${formatCurrency(stats.salesTotal)}*`,
        `🧾 Cantidad de ventas: *${stats.salesCount}* pedidos`,
        `🏷️ Ticket promedio: *${formatCurrency(stats.averageTicket)}*`,
        stats.cancelledCount > 0 ? `↩️ Pedidos anulados: *${stats.cancelledCount}*` : '',
      ].filter(Boolean);

      if (stats.top3Products.length > 0) {
        lines.push('', '🏆 *Top 3 productos más vendidos:*');
        for (const p of stats.top3Products) {
          lines.push(`• ${esc(p.name)}: *${formatQty(p.quantity)}* u. — *${formatCurrency(p.subtotal)}*`);
        }
      }

      if (stats.categories.length > 0) {
        lines.push('', '📊 *Desglose por categorías:*');
        for (const c of stats.categories) {
          lines.push(`• ${getCategoryIcon(c.category)} *${esc(c.category)}*: ${formatQty(c.quantity)} u. — *${formatCurrency(c.subtotal)}*`);
        }
      }

      const buttons = [
        [
          { text: '🔍 Ver productos por categoría', callbackData: `rotiseria:catmenu:${input.periodo || 'esta_semana'}` },
          { text: '🔄 Cambiar período', callbackData: 'rotiseria:stats_menu' },
        ],
      ];

      return { reply: lines.join('\n'), inlineKeyboard: buttons };
    },
  };

  const menuEstadisticas: ActionDef<Empty> = {
    name: 'menu_estadisticas',
    description: 'Menú interactivo de estadísticas de la rotisería por períodos.',
    kind: 'read',
    input: EmptyInput,
    handler: async () => {
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
      'Crea un nuevo producto en la rotisería. Datos: nombre, precio_unitario, precio_docena (opcional), categoria (opcional, ej. "empanadas", "pizzas", "sandwiches").',
    kind: 'write',
    input: CrearProductoInput,
    intro:
      'Para crear un producto decime nombre y precio unitario. Ejemplo: *"Crear empanada de carne a 1500, docena 15000"*.',
    fieldPrompts: {
      nombre: '¿Cómo se llama el producto?',
      precio_unitario: '¿Precio unitario?',
    },
    summarize: (i) =>
      [
        'Entendí el producto:',
        '',
        `📦 *${esc(i.nombre)}*`,
        `• Precio unitario: *${formatCurrency(i.precio_unitario)}*`,
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
        category: input.categoria,
      });

      return {
        reply: `✅ Creado *${esc(p.name)}* a ${formatCurrency(Number(p.priceUnit))}${p.priceDozen ? ` (docena ${formatCurrency(Number(p.priceDozen))})` : ''}.`,
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
    intro: 'Para crear una promo decime el nombre y precio. Ejemplo: *"Promo 1 a 16000: Muzza + 6 empanadas"*.',
    fieldPrompts: {
      nombre: '¿Cómo se llama la promo?',
      precio: '¿Cuál es el precio de la promo?',
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

  const consultarMenu: ActionDef<ConsultarMenu> = {
    name: 'consultar_menu',
    description: 'Muestra la lista de comidas, empanadas, pizzas y promos con sus precios vigentes. Dato opcional: categoria.',
    kind: 'read',
    input: ConsultarMenuInput,
    handler: async (ctx, input) => {
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

      const lines: string[] = ['📋 *Menú y Precios:*', ''];

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
    },
  };

  const consultarVentas: ActionDef<HistorialVentas> = {
    name: 'consultar_ventas',
    description: 'Muestra las últimas ventas registradas con su estado y detalle. Dato opcional: limite (1-20).',
    kind: 'read',
    input: HistorialVentasInput,
    handler: async (ctx, input) => {
      const recent = await sales.listRecentSales(ctx.tenant.business.id, input.limite);
      if (recent.length === 0) {
        return { reply: 'Todavía no hay ventas registradas.' };
      }

      const blocks = recent.map((sale) => {
        const status = sale.isCancelled ? ' ❌ *[ANULADA]*' : '';
        const items = sale.items.map((it) => `  • ${formatQty(Number(it.quantity))}x ${esc(it.name)}`).join('\n');
        return `🛒 *${formatCurrency(Number(sale.total))}* — _${formatDateTime(sale.createdAt)}_${status}\n${items}`;
      });

      return { reply: ['🧾 *Últimas ventas:*', '', ...blocks].join('\n') };
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
    consultarMenu,
    consultarVentas,
  ] as unknown as ActionDef<unknown>[];
}

export type { ActionContext };
