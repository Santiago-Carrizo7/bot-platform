import type { ActionDef, ActionContext } from '../../core/actions/registry.js';
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
import { esc, formatCurrency, formatDateTime, formatQty } from './format.js';
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
      'Registra una venta de rotisería con empanadas, pizzas, sándwiches o promos. Datos: items (lista de {nombre, cantidad}), nota (opcional). El total y docenas los calcula automáticamente el sistema.',
    kind: 'write',
    input: RegistrarVentaInput,
    intro:
      'Para registrar una venta decime qué y cuánto. Ejemplo: *"1 docena de carne y una muzza"* o *"8 empanadas de carne y 4 de pollo"*.',
    fieldPrompts: {
      items: '¿Qué se vendió? Decime productos y cantidades, por ejemplo: *"1 docena de carne y 1 pizza"*',
      nombre: '¿Qué producto o promo?',
      cantidad: '¿Qué cantidad?',
    },
    summarize: (i) => {
      const lines = i.items.map((it) => `• ${formatQty(it.cantidad)}x ${esc(it.nombre)}`).join('\n');
      return ['Entendí el pedido:', '', lines, i.nota ? `\n📝 Nota: ${esc(i.nota)}` : '', '\n¿Confirmar venta?'].join('\n');
    },
    handler: async (ctx, input) => {
      const result = await sales.createSale(
        ctx.tenant.business.id,
        ctx.actorUserId,
        input.items.map((it) => ({ name: it.nombre, quantity: it.cantidad })),
        input.nota
      );

      const replyLines = [
        `✅ Venta registrada por *${formatCurrency(Number(result.sale.total))}*`,
        '',
        ...result.pricing.breakdown,
      ];

      return {
        reply: replyLines.join('\n'),
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
      'Anula lógicamente una venta para corregir un error de caja. Datos opcionales: sale_id (si se omite anula la última activa), motivo.',
    kind: 'write',
    input: AnularVentaInput,
    intro: 'Para anular una venta decime si es la última o indicame el código de la venta.',
    summarize: (i) => {
      return [
        '⚠️ ¿Confirmar anulación de venta?',
        '',
        i.sale_id ? `Venta: #${esc(i.sale_id)}` : 'Se anulará la *última venta activa* registrada.',
        i.motivo ? `Motivo: ${esc(i.motivo)}` : '',
        '\nEsta venta se descontará de los totales de caja y estadísticas.',
      ].join('\n');
    },
    handler: async (ctx, input) => {
      const cancelled = await sales.cancelSale(
        ctx.tenant.business.id,
        ctx.actorUserId,
        input.sale_id,
        input.motivo
      );

      return {
        reply: `↩️ Venta por *${formatCurrency(Number(cancelled.total))}* anulada correctamente.\nYa no computa en el turno actual.`,
        audit: {
          action: 'sale.cancelled',
          entityType: 'rotiseria_sale',
          entityId: cancelled.id,
          metadata: {
            total: Number(cancelled.total),
            reason: input.motivo,
          },
        },
      };
    },
  };

  const cambiarPrecio: ActionDef<CambiarPrecio> = {
    name: 'cambiar_precio',
    description:
      'Modifica el precio unitario o precio de docena de un producto o el precio de una promo. Datos: nombre, precio_unitario (opcional), precio_docena (opcional).',
    kind: 'write',
    input: CambiarPrecioInput,
    intro:
      'Decime qué producto querés modificar y su nuevo precio. Ejemplo: *"Subir la docena de carne a 16000"* o *"Muzza a 9500"*.',
    fieldPrompts: {
      nombre: '¿Qué producto o promo?',
      precio_unitario: '¿Nuevo precio unitario?',
    },
    summarize: (i) => {
      const parts = [
        'Entendí el cambio de precio:',
        '',
        `🏷️ *${esc(i.nombre)}*`,
        i.precio_unitario ? `• Precio unitario: *${formatCurrency(i.precio_unitario)}*` : '',
        i.precio_docena ? `• Precio docena: *${formatCurrency(i.precio_docena)}*` : '',
        '\n¿Confirmar?',
      ].filter(Boolean);
      return parts.join('\n');
    },
    handler: async (ctx, input) => {
      const businessId = ctx.tenant.business.id;
      const product = await products.findProductByName(businessId, input.nombre);
      if (product) {
        const updated = await products.updateProduct(product.id, businessId, {
          priceUnit: input.precio_unitario,
          priceDozen: input.precio_docena,
        });
        const details = [
          `✅ Precio actualizado para *${esc(updated.name)}*:`,
          `• Unitario: *${formatCurrency(Number(updated.priceUnit))}*`,
          updated.priceDozen ? `• Docena: *${formatCurrency(Number(updated.priceDozen))}*` : '',
        ]
          .filter(Boolean)
          .join('\n');

        return {
          reply: details,
          audit: {
            action: 'product.price_updated',
            entityType: 'rotiseria_product',
            entityId: updated.id,
            metadata: { priceUnit: Number(updated.priceUnit), priceDozen: updated.priceDozen ? Number(updated.priceDozen) : null },
          },
        };
      }

      const promo = await products.findPromoByName(businessId, input.nombre);
      if (promo) {
        if (!input.precio_unitario) {
          throw new AppError('Para una promo tenés que indicar el precio.');
        }
        const updated = await products.updatePromo(promo.id, businessId, {
          price: input.precio_unitario,
        });
        return {
          reply: `✅ Precio actualizado para la promo *${esc(updated.name)}*: *${formatCurrency(Number(updated.price))}*.`,
          audit: {
            action: 'promo.price_updated',
            entityType: 'rotiseria_promo',
            entityId: updated.id,
            metadata: { price: Number(updated.price) },
          },
        };
      }

      throw new AppError(`No encontré ningún producto o promo con el nombre "${input.nombre}".`);
    },
  };

  const controlDias: ActionDef<ControlDias> = {
    name: 'control_dias',
    description: 'Consulta las ventas del turno actual o de una fecha anterior (cierre de anoche). Dato opcional: fecha.',
    kind: 'read',
    input: ControlDiasInput,
    handler: async (ctx, input) => {
      let targetDate: Date | undefined;
      if (input.fecha) {
        const clean = input.fecha.toLowerCase().trim();
        if (clean === 'ayer' || clean === 'anoche') {
          targetDate = new Date();
          targetDate.setUTCDate(targetDate.getUTCDate() - 1);
        } else if (clean !== 'hoy') {
          const parsed = new Date(input.fecha);
          if (!isNaN(parsed.getTime())) {
            targetDate = parsed;
          }
        }
      }

      const s = await sales.getDaySummary(ctx.tenant.business.id, targetDate);

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
    },
  };

  const consultarEstadisticas: ActionDef<ConsultarEstadisticas> = {
    name: 'consultar_estadisticas',
    description: 'Muestra estadísticas generales: facturación neta, ticket promedio y productos más vendidos. Dato opcional: periodo (semana o mes).',
    kind: 'read',
    input: ConsultarEstadisticasInput,
    handler: async (ctx, input) => {
      const stats = await sales.getStatsSummary(ctx.tenant.business.id, input.periodo);

      const lines = [
        `📈 *Estadísticas — ${stats.periodLabel}*`,
        '',
        `💰 Total facturado: *${formatCurrency(stats.salesTotal)}*`,
        `🧾 Cantidad de ventas: *${stats.salesCount}*`,
        `🏷️ Ticket promedio: *${formatCurrency(stats.averageTicket)}*`,
        stats.cancelledCount > 0 ? `↩️ Pedidos anulados: *${stats.cancelledCount}*` : '',
      ].filter(Boolean);

      if (stats.topProducts.length > 0) {
        lines.push('', '🏆 *Productos estrella:*');
        for (const p of stats.topProducts) {
          lines.push(`• ${esc(p.name)}: *${formatQty(p.quantity)}* u. — *${formatCurrency(p.subtotal)}*`);
        }
      }

      return { reply: lines.join('\n') };
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
        `• Unitario: *${formatCurrency(i.precio_unitario)}*`,
        i.precio_docena ? `• Docena: *${formatCurrency(i.precio_docena)}*` : '',
        `• Categoría: *${esc(i.categoria)}*`,
        '\n¿Confirmar creación?',
      ]
        .filter(Boolean)
        .join('\n'),
    handler: async (ctx, input) => {
      const created = await products.createProduct({
        businessId: ctx.tenant.business.id,
        name: input.nombre,
        priceUnit: input.precio_unitario,
        priceDozen: input.precio_docena,
        category: input.categoria,
      });

      return {
        reply: `✅ Producto *${esc(created.name)}* creado con éxito.`,
        audit: {
          action: 'product.created',
          entityType: 'rotiseria_product',
          entityId: created.id,
          metadata: { priceUnit: Number(created.priceUnit), priceDozen: created.priceDozen ? Number(created.priceDozen) : null },
        },
      };
    },
  };

  const crearPromo: ActionDef<CrearPromo> = {
    name: 'crear_promo',
    description: 'Crea una promoción cerrada (combo). Datos: nombre, precio, descripcion (opcional).',
    kind: 'write',
    input: CrearPromoInput,
    intro: 'Para crear una promo decime nombre y precio. Ejemplo: *"Crear Promo 2 a 18000: 2 Muzzas y 6 empanadas"*.',
    fieldPrompts: {
      nombre: '¿Cómo se llama la promo?',
      precio: '¿Cuál es el precio de la promo?',
    },
    summarize: (i) =>
      [
        'Entendí la promo:',
        '',
        `🎁 *${esc(i.nombre)}* — *${formatCurrency(i.precio)}*`,
        i.descripcion ? `📝 ${esc(i.descripcion)}` : '',
        '\n¿Confirmar creación?',
      ]
        .filter(Boolean)
        .join('\n'),
    handler: async (ctx, input) => {
      const created = await products.createPromo({
        businessId: ctx.tenant.business.id,
        name: input.nombre,
        price: input.precio,
        description: input.descripcion,
      });

      return {
        reply: `✅ Promo *${esc(created.name)}* creada con éxito.`,
        audit: {
          action: 'promo.created',
          entityType: 'rotiseria_promo',
          entityId: created.id,
          metadata: { price: Number(created.price) },
        },
      };
    },
  };

  const consultarMenu: ActionDef<ConsultarMenu> = {
    name: 'consultar_menu',
    description: 'Consulta los productos y promociones disponibles con sus precios. Dato opcional: categoria.',
    kind: 'read',
    input: ConsultarMenuInput,
    handler: async (ctx, input) => {
      const [productList, promoList] = await Promise.all([
        products.listProducts(ctx.tenant.business.id, { category: input.categoria }),
        products.listPromos(ctx.tenant.business.id),
      ]);

      if (productList.length === 0 && promoList.length === 0) {
        return { reply: 'No hay productos ni promociones cargadas todavía.' };
      }

      const lines: string[] = ['📋 *Menú y Precios:*', ''];

      if (promoList.length > 0) {
        lines.push('🎁 *Promociones:*');
        for (const pr of promoList) {
          lines.push(`• *${esc(pr.name)}*: *${formatCurrency(Number(pr.price))}*${pr.description ? ` (${esc(pr.description)})` : ''}`);
        }
        lines.push('');
      }

      if (productList.length > 0) {
        lines.push('🍽️ *Comidas:*');
        for (const p of productList) {
          const docenaStr = p.priceDozen ? ` (Docena: *${formatCurrency(Number(p.priceDozen))}*)` : '';
          lines.push(`• *${esc(p.name)}*: *${formatCurrency(Number(p.priceUnit))}*${docenaStr}`);
        }
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
    anularVenta,
    cambiarPrecio,
    crearProducto,
    crearPromo,
    consultarMenu,
    consultarVentas,
  ] as unknown as ActionDef<unknown>[];
}

export type { ActionContext };
