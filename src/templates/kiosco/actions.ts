import type { ActionDef, ActionContext } from '../../core/actions/registry.js';
import type { ProductService } from './domain/product.service.js';
import type { SaleService } from './domain/sale.service.js';
import type { CashService } from './domain/cash.service.js';
import {
  ConsultarStockInput,
  CrearProductoInput,
  EliminarProductoInput,
  EmptyInput,
  FijarStockInput,
  HistorialVentasInput,
  ModificarProductoInput,
  RegistrarCompraInput,
  RegistrarEntradaInput,
  RegistrarGastoInput,
  RegistrarVentaInput,
  ResumenMesInput,
  type ConsultarStockInput as ConsultarStock,
  type CrearProductoInput as CrearProducto,
  type EliminarProductoInput as EliminarProducto,
  type EmptyInput as Empty,
  type FijarStockInput as FijarStock,
  type HistorialVentasInput as HistorialVentas,
  type ModificarProductoInput as ModificarProducto,
  type RegistrarCompraInput as RegistrarCompra,
  type RegistrarEntradaInput as RegistrarEntrada,
  type RegistrarGastoInput as RegistrarGasto,
  type RegistrarVentaInput as RegistrarVenta,
  type ResumenMesInput as ResumenMes,
} from './schemas.js';
import { esc, formatCurrency, formatDateTime, formatQty } from './format.js';

export interface KioscoActionDeps {
  products: ProductService;
  sales: SaleService;
  cash: CashService;
}

export function buildKioscoActions(deps: KioscoActionDeps): ActionDef<unknown>[] {
  const { products, sales, cash } = deps;

  const registrarVenta: ActionDef<RegistrarVenta> = {
    name: 'registrar_venta',
    description:
      'Registra una venta con uno o más productos. Datos: items (lista de {producto: nombre exacto del catálogo, cantidad: número positivo}), nota (opcional). El total lo calcula el sistema.',
    kind: 'write',
    input: RegistrarVentaInput,
    intro:
      'Para registrar la venta decime *qué* y *cuántos*, todo junto. Por ejemplo: *"Vendí 3 Coca y 2 alfajores"*.',
    fieldPrompts: {
      items: '¿Qué vendiste? Decime producto y cantidad, por ejemplo: *"2 Coca y 1 alfajor"*.',
      producto: '¿Qué producto? Usá el nombre como figura en el catálogo.',
      cantidad: '¿Qué cantidad?',
    },
    summarize: (i) => {
      const lines = i.items.map((it) => `• ${formatQty(it.cantidad)}x ${esc(it.producto)}`).join('\n');
      return ['Entendí la venta:', '', lines, i.nota ? `\n📝 Nota: ${esc(i.nota)}` : '', '\n¿Confirmar?'].join('\n');
    },
    handler: async (ctx, input) => {
      const result = await sales.createSale(
        ctx.tenant.business.id,
        ctx.actorUserId,
        input.items.map((it) => ({ productName: it.producto, quantity: it.cantidad })),
        input.nota
      );
      const lines = result.lines
        .map((l) => `• ${formatQty(l.quantity)}x ${esc(l.productName)} — *${formatCurrency(l.subtotal)}*`)
        .join('\n');
      const warnings =
        result.negativeStock.length > 0
          ? `\n\n⚠️ _Stock en negativo: ${result.negativeStock.map((w) => `${esc(w.productName)} (${formatQty(w.stock)})`).join(', ')}. Revisá la carga de stock._`
          : '';
      return {
        reply: [`✅ Venta registrada por *${formatCurrency(Number(result.sale.total))}*`, '', lines, warnings].join('\n'),
        audit: {
          action: 'sale.created',
          entityType: 'sale',
          entityId: result.sale.id,
          metadata: { total: Number(result.sale.total), items: result.lines.length },
        },
      };
    },
  };

  const crearProducto: ActionDef<CrearProducto> = {
    name: 'crear_producto',
    description:
      'Crea un producto del kiosco. Datos: nombre, precio_venta (número positivo, precio al que se vende), precio_costo (opcional), stock_inicial (opcional, por defecto 0), stock_minimo (opcional, para aviso de stock bajo), unidad (opcional, por defecto "unidad").',
    kind: 'write',
    input: CrearProductoInput,
    intro:
      'Para crear el producto necesito *nombre* y *precio de venta*. Podés agregar stock inicial y más datos. Ejemplo: *"Crear producto Coca Cola 2.5L a 3500 con stock 12"*.',
    fieldPrompts: {
      nombre: '¿Cómo se llama el producto?',
      precio_venta: '¿A cuánto se vende?',
    },
    summarize: (i) =>
      [
        'Entendí el producto:',
        '',
        `📦 *${esc(i.nombre)}* — *${formatCurrency(i.precio_venta)}*`,
        `📊 Stock inicial: *${formatQty(i.stock_inicial)}* ${esc(i.unidad)}`,
        i.precio_costo ? `💵 Costo: *${formatCurrency(i.precio_costo)}*` : '',
        i.stock_minimo !== undefined ? `⚠️ Aviso si baja de *${formatQty(i.stock_minimo)}*` : '',
        '',
        '¿Confirmar?',
      ].join('\n'),
    handler: async (ctx, input) => {
      const product = await products.create(ctx.tenant.business.id, ctx.actorUserId, {
        name: input.nombre,
        salePrice: input.precio_venta,
        costPrice: input.precio_costo,
        stock: input.stock_inicial,
        minStock: input.stock_minimo,
        unit: input.unidad,
      });
      return {
        reply: `✅ Producto *${esc(product.name)}* creado a *${formatCurrency(Number(product.salePrice))}* con stock *${formatQty(Number(product.stock))}*.`,
        audit: { action: 'product.created', entityType: 'product', entityId: product.id, metadata: { name: product.name } },
      };
    },
  };

  const modificarProducto: ActionDef<ModificarProducto> = {
    name: 'modificar_producto',
    description:
      'Modifica un producto existente. Datos: nombre_actual (obligatorio), y al menos uno de: nuevo_nombre, precio_venta, precio_costo, stock_minimo, unidad.',
    kind: 'write',
    input: ModificarProductoInput,
    intro: 'Decime *qué producto* querés modificar y *qué* cambiar. Ejemplo: *"Cambiar precio de Coca a 3800"*.',
    fieldPrompts: {
      nombre_actual: '¿Qué producto querés modificar?',
    },
    summarize: (i) => {
      const changes = [
        i.nuevo_nombre ? `nuevo nombre: *${esc(i.nuevo_nombre)}*` : '',
        i.precio_venta !== undefined ? `precio: *${formatCurrency(i.precio_venta)}*` : '',
        i.precio_costo !== undefined ? `costo: *${formatCurrency(i.precio_costo)}*` : '',
        i.stock_minimo !== undefined ? `stock mínimo: *${formatQty(i.stock_minimo)}*` : '',
        i.unidad ? `unidad: *${esc(i.unidad)}*` : '',
      ].filter(Boolean).join('\n');
      return `Modificar *${esc(i.nombre_actual)}*:\n${changes}\n\n¿Confirmar?`;
    },
    handler: async (ctx, input) => {
      const product = await products.update(ctx.tenant.business.id, input.nombre_actual, {
        name: input.nuevo_nombre,
        salePrice: input.precio_venta,
        costPrice: input.precio_costo,
        minStock: input.stock_minimo,
        unit: input.unidad,
      });
      return {
        reply: `✅ Producto actualizado: *${esc(product.name)}* a *${formatCurrency(Number(product.salePrice))}*.`,
        audit: { action: 'product.updated', entityType: 'product', entityId: product.id },
      };
    },
  };

  const eliminarProducto: ActionDef<EliminarProducto> = {
    name: 'eliminar_producto',
    description: 'Da de baja un producto (se conserva el historial). Dato: nombre.',
    kind: 'write',
    input: EliminarProductoInput,
    summarize: (i) => `¿Confirmás dar de baja *${esc(i.nombre)}*? (Se conserva el historial.)`,
    handler: async (ctx, input) => {
      const product = await products.deactivate(ctx.tenant.business.id, input.nombre);
      return {
        reply: `🗑️ Producto *${esc(product.name)}* dado de baja.`,
        audit: { action: 'product.deactivated', entityType: 'product', entityId: product.id },
      };
    },
  };

  const fijarStock: ActionDef<FijarStock> = {
    name: 'fijar_stock',
    description:
      'Fija el stock de un producto en un valor exacto (para correcciones o conteo). Datos: producto, cantidad (nueva cantidad total, >= 0).',
    kind: 'write',
    input: FijarStockInput,
    intro: 'Decime *qué producto* y la *cantidad total* que hay. Ejemplo: *"Stock de Coca: 24"*.',
    fieldPrompts: {
      producto: '¿De qué producto?',
      cantidad: '¿Cuánto hay en total?',
    },
    summarize: (i) => `Fijar stock de *${esc(i.producto)}* en *${formatQty(i.cantidad)}*.\n\n¿Confirmar?`,
    handler: async (ctx, input) => {
      const { product, previous } = await products.setStock(
        ctx.tenant.business.id, ctx.actorUserId, input.producto, input.cantidad
      );
      return {
        reply: `✅ Stock de *${esc(product.name)}*: ${formatQty(previous)} → *${formatQty(Number(product.stock))}*.`,
        audit: { action: 'stock.adjusted', entityType: 'product', entityId: product.id, metadata: { previous, current: Number(product.stock) } },
      };
    },
  };

  const registrarCompra: ActionDef<RegistrarCompra> = {
    name: 'registrar_compra',
    description:
      'Registra una compra o gasto de mercadería (sale dinero). Datos: descripcion, monto. Opcional: producto + cantidad si entra mercadería al stock.',
    kind: 'write',
    input: RegistrarCompraInput,
    intro:
      'Decime *qué compraste* y *cuánto pagaste*, todo junto. Si es mercadería para stock, agregá producto y cantidad. Ejemplo: *"Compré 2 cajones de Coca a 20000"*.',
    fieldPrompts: {
      descripcion: '¿Qué compraste?',
      monto: '¿Cuánto pagaste en total?',
    },
    summarize: (i) => {
      const stock = i.producto && i.cantidad ? `\n📦 Entra al stock: *${formatQty(i.cantidad)}* de *${esc(i.producto)}*` : '';
      return `Entendí la compra:\n\n💸 *${formatCurrency(i.monto)}* — ${esc(i.descripcion)}${stock}\n\n¿Confirmar?`;
    },
    handler: async (ctx, input) => {
      const result = await deps.cash.registerPurchase(ctx.tenant.business.id, ctx.actorUserId, {
        description: input.descripcion,
        amount: input.monto,
        productName: input.producto,
        quantity: input.cantidad,
      });
      const stock = result.stockAdded
        ? `\n📦 Stock de *${esc(result.stockAdded.productName)}* ahora: *${formatQty(result.stockAdded.stock)}*.`
        : '';
      return {
        reply: `✅ Compra registrada: *${formatCurrency(input.monto)}* — ${esc(input.descripcion)}.${stock}`,
        audit: { action: 'purchase.created', entityType: 'purchase', entityId: result.movementId, metadata: { amount: input.monto } },
      };
    },
  };

  const registrarGasto: ActionDef<RegistrarGasto> = {
    name: 'registrar_gasto',
    description:
      'Registra un gasto que NO es mercadería (luz, alquiler, etc.). Datos: descripcion, monto.',
    kind: 'write',
    input: RegistrarGastoInput,
    intro: 'Decime *qué pagaste* y *cuánto*. Ejemplo: *"Pagué 15000 de luz"*.',
    fieldPrompts: {
      descripcion: '¿Qué pagaste?',
      monto: '¿Cuánto fue?',
    },
    summarize: (i) => `Entendí el gasto:\n\n💸 *${formatCurrency(i.monto)}* — ${esc(i.descripcion)}\n\n¿Confirmar?`,
    handler: async (ctx, input) => {
      const movement = await deps.cash.moneyOut(ctx.tenant.business.id, ctx.actorUserId, {
        concept: input.descripcion,
        amount: input.monto,
        category: 'gastos',
      });
      return {
        reply: `✅ Gasto registrado: *${formatCurrency(input.monto)}* — ${esc(input.descripcion)}.`,
        audit: { action: 'expense.created', entityType: 'money_movement', entityId: movement.id, metadata: { amount: input.monto } },
      };
    },
  };

  const registrarEntrada: ActionDef<RegistrarEntrada> = {
    name: 'registrar_entrada',
    description: 'Registra una entrada de dinero que NO es una venta (ej. te pagaron una deuda). Datos: descripcion, monto.',
    kind: 'write',
    input: RegistrarEntradaInput,
    intro: 'Decime *qué entró* y *cuánto*. Ejemplo: *"Me pagaron 5000 que me debían"*.',
    fieldPrompts: {
      descripcion: '¿Qué entró?',
      monto: '¿Cuánto fue?',
    },
    summarize: (i) => `Entendí la entrada:\n\n💰 *${formatCurrency(i.monto)}* — ${esc(i.descripcion)}\n\n¿Confirmar?`,
    handler: async (ctx, input) => {
      const movement = await deps.cash.moneyIn(ctx.tenant.business.id, ctx.actorUserId, {
        concept: input.descripcion,
        amount: input.monto,
        category: 'entradas',
      });
      return {
        reply: `✅ Entrada registrada: *${formatCurrency(input.monto)}* — ${esc(input.descripcion)}.`,
        audit: { action: 'income.created', entityType: 'money_movement', entityId: movement.id, metadata: { amount: input.monto } },
      };
    },
  };

  const consultarStock: ActionDef<ConsultarStock> = {
    name: 'consultar_stock',
    description:
      'Consulta el stock de productos. Datos opcionales: busqueda (texto para filtrar), solo_bajos (true para ver solo stock bajo), limite.',
    kind: 'read',
    input: ConsultarStockInput,
    handler: async (ctx, input) => {
      const list = await products.list(ctx.tenant.business.id, {
        search: input.busqueda,
        onlyLowStock: input.solo_bajos,
        limit: input.limite,
      });
      if (list.length === 0) {
        return { reply: input.solo_bajos ? '✅ No hay productos con stock bajo.' : 'No hay productos cargados. Creá el primero con "crear producto ...".' };
      }
      if (list.length === 1 && input.busqueda) {
        const p = list[0];
        const low = p.minStock !== null && Number(p.stock) <= Number(p.minStock) ? ' ⚠️ *BAJO*' : '';
        return {
          reply: [
            `📦 *${esc(p.name)}*${low}`,
            `💰 Precio: *${formatCurrency(Number(p.salePrice))}*`,
            `📊 Stock: *${formatQty(Number(p.stock))}* ${esc(p.unit)}`,
            p.minStock !== null ? `⚠️ Mínimo: *${formatQty(Number(p.minStock))}*` : '',
          ].join('\n'),
        };
      }
      const lines = list.map((p) => {
        const low = p.minStock !== null && Number(p.stock) <= Number(p.minStock) ? ' ⚠️' : '';
        return `• ${esc(p.name)}: *${formatQty(Number(p.stock))}* (${formatCurrency(Number(p.salePrice))})${low}`;
      });
      const title = input.solo_bajos ? '⚠️ *Productos con stock bajo:*' : '📦 *Stock:*';
      return { reply: [title, '', ...lines].join('\n') };
    },
  };

  const consultarCajaHoy: ActionDef<Empty> = {
    name: 'consultar_caja_hoy',
    description: 'Muestra la caja del día: ventas, entradas, salidas y neto. No necesita datos.',
    kind: 'read',
    input: EmptyInput,
    handler: async (ctx) => {
      const summary = await deps.cash.getDaySummary(ctx.tenant.business.id);
      return {
        reply: [
          '🧾 *Caja de hoy:*',
          '',
          `🛒 Ventas: *${formatCurrency(summary.salesTotal)}* (${summary.salesCount})`,
          `💰 Entró: *${formatCurrency(summary.totalIn)}*`,
          `💸 Salió: *${formatCurrency(summary.totalOut)}*`,
          `⚖️ Neto: *${formatCurrency(summary.net)}*`,
        ].join('\n'),
      };
    },
  };

  const consultarResumenMes: ActionDef<ResumenMes> = {
    name: 'consultar_resumen_mes',
    description: 'Resumen del mes con ventas, movimientos y neto. Datos opcionales: year, month.',
    kind: 'read',
    input: ResumenMesInput,
    handler: async (ctx, input) => {
      let refDate = new Date();
      if (input.year && input.month) {
        refDate = new Date(input.year, input.month - 1, 1, 12, 0, 0);
      }
      const s = await deps.cash.getMonthSummary(ctx.tenant.business.id, refDate);
      return {
        reply: [
          `📊 *Resumen de ${s.monthName} ${s.year}:*`,
          '',
          `🛒 Ventas: *${formatCurrency(s.salesTotal)}* (${s.salesCount})`,
          `💰 Entró: *${formatCurrency(s.totalIn)}*`,
          `💸 Salió: *${formatCurrency(s.totalOut)}*`,
          `⚖️ Neto: *${formatCurrency(s.net)}*`,
        ].join('\n'),
      };
    },
  };

  const consultarVentas: ActionDef<HistorialVentas> = {
    name: 'consultar_ventas',
    description: 'Muestra las últimas ventas con su detalle. Dato opcional: limite (1-20).',
    kind: 'read',
    input: HistorialVentasInput,
    handler: async (ctx, input) => {
      const recent = await deps.sales.listRecent(ctx.tenant.business.id, input.limite);
      if (recent.length === 0) return { reply: 'Todavía no hay ventas registradas.' };
      const blocks = recent.map((sale) => {
        const items = sale.items.map((it) => `  • ${formatQty(Number(it.quantity))}x ${esc(it.productName)}`).join('\n');
        return `🛒 *${formatCurrency(Number(sale.total))}* — _${formatDateTime(sale.createdAt)}_\n${items}`;
      });
      return { reply: ['🧾 *Últimas ventas:*', '', ...blocks].join('\n') };
    },
  };

  return [
    registrarVenta,
    crearProducto,
    modificarProducto,
    eliminarProducto,
    fijarStock,
    registrarCompra,
    registrarGasto,
    registrarEntrada,
    consultarStock,
    consultarCajaHoy,
    consultarResumenMes,
    consultarVentas,
  ] as unknown as ActionDef<unknown>[];
}

export type { ActionContext };
