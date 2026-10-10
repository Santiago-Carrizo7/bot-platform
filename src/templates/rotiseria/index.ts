import type { PrismaClient } from '@prisma/client';
import type {
  BotReply,
  CommandDef,
  InlineButton,
  TemplateDefinition,
} from '../../core/actions/registry.js';
import { ProductRepository } from './persistence/product.repo.js';
import { SaleRepository } from './persistence/sale.repo.js';
import { ProductService } from './domain/product.service.js';
import { SaleService } from './domain/sale.service.js';
import { StatsService } from './domain/stats.service.js';
import { buildRotiseriaActions } from './actions.js';
import { buildRotiseriaSystemPrompt } from './prompts.js';
import {
  esc,
  formatCurrency,
  formatDateOnly,
  formatQty,
  formatRealDateWithDay,
  formatSaleNumber,
  formatSaleSummary,
  formatTimeOnly,
  getCategoryIcon,
} from './format.js';
import { calculatePricing } from './domain/pricing.js';
import { getShiftDate } from './domain/shift.js';
import { applyModification, parseModificationText } from './domain/modification.js';

export interface RotiseriaTemplateDeps {
  db: PrismaClient;
  products?: ProductService;
  sales?: SaleService;
}

export interface RotiseriaTemplateBundle {
  template: TemplateDefinition;
  seedBusiness: (businessId: string) => Promise<void>;
}

const COMMANDS: CommandDef[] = [
  { command: 'venta', description: '📝 Registrar venta', action: 'registrar_venta' },
  { command: 'dias', description: '📅 Control de días recientes', action: 'control_dias' },
  { command: 'estadisticas', description: '📈 Estadísticas de ventas', action: 'menu_estadisticas' },
  { command: 'stats', description: '📈 Estadísticas de ventas', action: 'menu_estadisticas' },
  { command: 'anular', description: '↩️ Anular última venta', action: 'anular_venta' },
  { command: 'precio', description: '🏷️ Modificar precios de la carta', action: 'cambiar_precio' },
  { command: 'menu', description: '📋 Ver carta y promociones vigentes', action: 'consultar_menu' },
  { command: 'ventas', description: '🧾 Últimas ventas registradas', action: 'consultar_ventas' },
  { command: 'producto', description: '➕ Crear comida o empanada', action: 'crear_producto' },
  { command: 'promo', description: '🎁 Crear promo', action: 'crear_promo' },
];

export function createRotiseriaTemplate(deps: RotiseriaTemplateDeps): RotiseriaTemplateBundle {
  const productRepo = new ProductRepository(deps.db);
  const saleRepo = new SaleRepository(deps.db);

  const products = deps.products ?? new ProductService(productRepo);
  const stats = new StatsService(saleRepo);
  const sales = deps.sales ?? new SaleService(saleRepo, products, stats);

  const template: TemplateDefinition = {
    id: 'rotiseria',
    label: 'Rotisería / Sándwiches y Empanadas',
    welcome: (businessName) =>
      [
        `👋 ¡Hola! Soy el asistente de *${businessName}*.`,
        '',
        '📝 Para registrar ventas, mandame un audio o escribí directo:',
        '• "Una docena de salteñas y dos sándwiches de milanesa"',
        '• "3 empanadas de pollo y una coca"',
        '',
        'Tenés los accesos rápidos en los botones de abajo o tocá /menu para ver opciones.',
      ].join('\n'),
    systemPrompt: (businessName, referenceDate, hints) =>
      buildRotiseriaSystemPrompt(businessName, referenceDate, hints),
    resolveHints: async (tenant) => {
      const [productList, promoList] = await Promise.all([
        products.listProducts(tenant.business.id, { limit: 100 }),
        products.listPromos(tenant.business.id),
      ]);

      const lines: string[] = [];
      if (promoList.length > 0) {
        lines.push('Promos:');
        for (const pr of promoList) {
          lines.push(`- Promo "${pr.name}" (${formatCurrency(Number(pr.price))})`);
        }
      }
      if (productList.length > 0) {
        lines.push('Productos:');
        for (const p of productList) {
          const docena = p.priceDozen ? `, docena ${formatCurrency(Number(p.priceDozen))}` : '';
          lines.push(`- ${p.name} (unidad ${formatCurrency(Number(p.priceUnit))}${docena})`);
        }
      }

      if (lines.length === 0) return '';
      return lines.join('\n').slice(0, 1500);
    },
    actions: buildRotiseriaActions({ products, sales }),
    commands: COMMANDS,
    welcomeHint: async (tenant) => {
      const existing = await products.listProducts(tenant.business.id, { limit: 1 });
      if (existing.length > 0) return null;
      return (
        '⚠️ Todavía no cargaste comidas ni promos. Podés crear la primera escribiendo por ejemplo: ' +
        '*"Crear empanada de carne a 1500, docena 15000"*.'
      );
    },
    interpretDirectly: (text, activeActionName, activeData) => {
      const trimmed = text.trim();
      if (activeActionName === 'registrar_venta') {
        // Detección de fecha cuando se espera ingreso manual
        if (activeData?._awaitingCustomDate) {
          const dateMatch = trimmed.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
          if (dateMatch) {
            const day = parseInt(dateMatch[1], 10);
            const month = parseInt(dateMatch[2], 10);
            const rawYear = dateMatch[3] ? parseInt(dateMatch[3], 10) : new Date().getUTCFullYear();
            const year = rawYear < 100 ? 2000 + rawYear : rawYear;
            if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
              const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
              const parsedDate = new Date(`${iso}T12:00:00Z`);
              if (!isNaN(parsedDate.getTime())) {
                const todayShift = getShiftDate(new Date());
                if (parsedDate.getTime() > todayShift.getTime() + 12 * 3600_000) {
                  return {
                    actionName: 'registrar_venta',
                    params: { _futureDate: true, _awaitingCustomDate: true },
                  };
                }
                return {
                  actionName: 'registrar_venta',
                  params: { fecha: iso, _futureDate: false, _awaitingCustomDate: false },
                };
              }
            }
          }
        }

        // Modificación de pedido en curso
        if (activeData?._modifying && Array.isArray(activeData.items)) {
          const currentItems = activeData.items.map((it: any) => ({
            name: String(it.nombre ?? it.name),
            quantity: Number(it.cantidad ?? it.quantity),
          }));
          const patch = parseModificationText(trimmed, currentItems);
          if (patch) {
            const updated = applyModification(currentItems, patch);
            if (updated.length > 0) {
              return {
                actionName: 'registrar_venta',
                params: {
                  items: updated.map((it) => ({ nombre: it.name, cantidad: it.quantity })),
                  _modifying: true,
                },
              };
            }
          }
        }
      }

      // Ingreso de precio manual durante el flujo guiado de cambio de precio
      if (activeActionName === 'cambiar_precio' && activeData?._awaitingPriceForProductId) {
        const parts = trimmed.split('/');
        const unitStr = parts[0].replace(/[^0-9.,]/g, '').replace(',', '.');
        const unitVal = parseFloat(unitStr);
        if (!isNaN(unitVal) && unitVal > 0) {
          let dozenVal: number | undefined;
          if (parts[1]) {
            const dozenStr = parts[1].replace(/[^0-9.,]/g, '').replace(',', '.');
            const dVal = parseFloat(dozenStr);
            if (!isNaN(dVal) && dVal > 0) dozenVal = dVal;
          }
          return {
            actionName: 'cambiar_precio',
            params: {
              product_id: String(activeData._awaitingPriceForProductId),
              nombre: String(activeData.productName),
              precio_unitario: unitVal,
              precio_docena: dozenVal,
            },
          };
        }
      }

      return null;
    },
    replyMenu: [
      { label: '📝 Registrar venta', action: 'registrar_venta' },
      { label: '📅 Control de días', action: 'control_dias' },
      { label: '📈 Estadísticas', action: 'menu_estadisticas' },
      { label: '↩️ Anular venta', action: 'anular_venta' },
      { label: '🏷️ Cambiar precio', action: 'cambiar_precio' },
    ],
    replyMenuLayout: [1, 2, 2],
    menu: [
      { label: '📝 Registrar venta', action: 'registrar_venta' },
      { label: '📅 Control de días recientes', action: 'control_dias' },
      { label: '📈 Estadísticas de ventas', action: 'menu_estadisticas' },
      { label: '↩️ Anular última venta', action: 'anular_venta' },
      { label: '🏷️ Modificar precios de la carta', action: 'cambiar_precio' },
      { label: '📋 Ver carta y promociones vigentes', action: 'consultar_menu' },
      { label: '🧾 Últimas ventas registradas', action: 'consultar_ventas' },
      { label: '➕ Crear comida o empanada', action: 'crear_producto' },
      { label: '🎁 Crear promo', action: 'crear_promo' },
    ],
    menuCommands: [
      { command: 'venta', description: '📝 Registrar venta' },
      { command: 'dias', description: '📅 Control de días recientes' },
      { command: 'estadisticas', description: '📈 Estadísticas de ventas' },
      { command: 'anular', description: '↩️ Anular última venta' },
      { command: 'precio', description: '🏷️ Modificar precios de la carta' },
      { command: 'menu', description: '📋 Ver carta y promociones vigentes' },
      { command: 'ventas', description: '🧾 Últimas ventas registradas' },
    ],
    handleCallback: async (ctx, data, activeState, conversations, audit) => {
      // 1. Modificar pedido
      if (data === 'rotiseria:modificar') {
        const currentData = (activeState?.data ?? {}) as Record<string, unknown>;
        const items = Array.isArray(currentData.items) ? currentData.items : [];
        let breakdown: string[] | undefined;
        let total: number | undefined;
        try {
          const catalog = await products.getCatalogLookup(ctx.tenant.business.id);
          const pricing = calculatePricing(
            items.map((it: any) => ({ name: it.nombre ?? it.name, quantity: it.cantidad ?? it.quantity })),
            catalog
          );
          breakdown = pricing.breakdown;
          total = pricing.total;
        } catch {
          // fallback
        }

        const summary = formatSaleSummary({
          items: items.map((it: any) => ({ nombre: it.nombre ?? it.name, cantidad: it.cantidad ?? it.quantity })),
          nota: currentData.nota as string | undefined,
          fecha: currentData.fecha as string | undefined,
          breakdown,
          total,
          isModifying: false,
          now: ctx.now,
          timezone: ctx.tenant.business.timezone,
        });

        const cleanSummary = summary.replace(/¿Confirmar venta\?|¿Confirmamos esta venta\?/g, '').trim();

        if (conversations && activeState) {
          await conversations.upsert({
            businessId: ctx.tenant.business.id,
            userId: ctx.actorUserId,
            phase: 'COLLECTING',
            actionName: 'registrar_venta',
            data: {
              ...activeState.data,
              _modifying: true,
            },
            expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
            updatedAt: ctx.now,
          });
        }
        return {
          text: `${cleanSummary}\n\n¿Qué modificamos o agregamos? Podés sumar productos, cambiar cantidades o sacar ítems (ej: *"sacá la pizza"* o *"cambiá las 12 de carne por pollo"*).`,
          parseMode: 'Markdown',
        };
      }

      // 2. Cambiar fecha (mostrar selector)
      if (data === 'rotiseria:fecha') {
        const tz = ctx.tenant.business.timezone ?? 'America/Argentina/Buenos_Aires';
        const todayShift = getShiftDate(ctx.now, tz);
        const yesterdayShift = new Date(todayShift);
        yesterdayShift.setUTCDate(yesterdayShift.getUTCDate() - 1);

        const todayIso = todayShift.toISOString().slice(0, 10);
        const yesterdayIso = yesterdayShift.toISOString().slice(0, 10);

        const currentData = (activeState?.data ?? {}) as Record<string, unknown>;
        const items = Array.isArray(currentData.items) ? currentData.items : [];
        let breakdown: string[] | undefined;
        let total: number | undefined;
        try {
          const catalog = await products.getCatalogLookup(ctx.tenant.business.id);
          const pricing = calculatePricing(
            items.map((it: any) => ({ name: it.nombre ?? it.name, quantity: it.cantidad ?? it.quantity })),
            catalog
          );
          breakdown = pricing.breakdown;
          total = pricing.total;
        } catch {
          // fallback
        }

        const summary = formatSaleSummary({
          items: items.map((it: any) => ({ nombre: it.nombre ?? it.name, cantidad: it.cantidad ?? it.quantity })),
          nota: currentData.nota as string | undefined,
          fecha: currentData.fecha as string | undefined,
          breakdown,
          total,
          isModifying: false,
          now: ctx.now,
          timezone: tz,
        });

        const cleanSummary = summary.replace(/¿Confirmar venta\?|¿Confirmamos esta venta\?/g, '').trim();

        return {
          text: `${cleanSummary}\n\n📅 *Seleccioná la fecha operativa para esta venta:*`,
          parseMode: 'Markdown',
          inlineKeyboard: [
            [
              { text: `${formatDateOnly(todayShift)} (Turno actual)`, callbackData: `rotiseria:setdate:${todayIso}` },
            ],
            [
              { text: `${formatDateOnly(yesterdayShift)} (Ayer)`, callbackData: `rotiseria:setdate:${yesterdayIso}` },
            ],
            [
              { text: '✏️ Otra fecha (DD/MM)', callbackData: 'rotiseria:askdate' },
              { text: '⬅️ Volver', callbackData: 'rotiseria:volver_confirm' },
            ],
          ],
        };
      }

      // 3. Setear fecha específica
      if (data.startsWith('rotiseria:setdate:')) {
        const dateStr = data.slice('rotiseria:setdate:'.length);

        const currentData = (activeState?.data ?? {}) as Record<string, unknown>;
        const updatedData: Record<string, unknown> = {
          ...currentData,
          fecha: dateStr,
          _awaitingCustomDate: false,
        };

        if (conversations) {
          await conversations.upsert({
            businessId: ctx.tenant.business.id,
            userId: ctx.actorUserId,
            phase: 'CONFIRMING',
            actionName: 'registrar_venta',
            data: updatedData,
            expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
            updatedAt: ctx.now,
          });
        }

        const items = Array.isArray(updatedData.items) ? updatedData.items : [];
        let breakdown: string[] | undefined;
        let total: number | undefined;
        try {
          const catalog = await products.getCatalogLookup(ctx.tenant.business.id);
          const pricing = calculatePricing(
            items.map((it: any) => ({ name: it.nombre ?? it.name, quantity: it.cantidad ?? it.quantity })),
            catalog
          );
          breakdown = pricing.breakdown;
          total = pricing.total;
        } catch {
          // fallback si falla catálogo
        }

        const summaryText = formatSaleSummary({
          items: items.map((it: any) => ({ nombre: it.nombre ?? it.name, cantidad: it.cantidad ?? it.quantity })),
          nota: updatedData.nota as string | undefined,
          fecha: dateStr,
          breakdown,
          total,
          isModifying: Boolean(updatedData._modifying),
          now: ctx.now,
          timezone: ctx.tenant.business.timezone,
        });

        return {
          text: summaryText,
          parseMode: 'Markdown',
          inlineKeyboard: [
            [
              { text: '✅ Confirmar venta', callbackData: 'confirm:yes' },
              { text: '❌ Cancelar', callbackData: 'confirm:no' },
            ],
            [
              { text: '✏️ Modificar pedido', callbackData: 'rotiseria:modificar' },
              { text: '📅 Cambiar fecha', callbackData: 'rotiseria:fecha' },
            ],
          ],
        };
      }

      // 4. Pedir fecha personalizada
      if (data === 'rotiseria:askdate') {
        if (conversations && activeState) {
          await conversations.upsert({
            businessId: ctx.tenant.business.id,
            userId: ctx.actorUserId,
            phase: 'COLLECTING',
            actionName: 'registrar_venta',
            data: {
              ...activeState.data,
              _awaitingCustomDate: true,
            },
            expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
            updatedAt: ctx.now,
          });
        }
        return {
          text: '📅 Escribí la fecha operativa en formato *DD/MM* o *DD/MM/AAAA* (ej: *08/10*):',
          parseMode: 'Markdown',
        };
      }

      // 5. Volver a confirmación
      if (data === 'rotiseria:volver_confirm') {
        const currentData = (activeState?.data ?? {}) as Record<string, unknown>;
        const items = Array.isArray(currentData.items) ? currentData.items : [];
        let breakdown: string[] | undefined;
        let total: number | undefined;
        try {
          const catalog = await products.getCatalogLookup(ctx.tenant.business.id);
          const pricing = calculatePricing(
            items.map((it: any) => ({ name: it.nombre ?? it.name, quantity: it.cantidad ?? it.quantity })),
            catalog
          );
          breakdown = pricing.breakdown;
          total = pricing.total;
        } catch {
          // fallback si falla catálogo
        }

        const summaryText = formatSaleSummary({
          items: items.map((it: any) => ({ nombre: it.nombre ?? it.name, cantidad: it.cantidad ?? it.quantity })),
          nota: currentData.nota as string | undefined,
          fecha: currentData.fecha as string | undefined,
          breakdown,
          total,
          isModifying: Boolean(currentData._modifying),
          now: ctx.now,
          timezone: ctx.tenant.business.timezone,
        });

        return {
          text: summaryText,
          parseMode: 'Markdown',
          inlineKeyboard: [
            [
              { text: '✅ Confirmar venta', callbackData: 'confirm:yes' },
              { text: '❌ Cancelar', callbackData: 'confirm:no' },
            ],
            [
              { text: '✏️ Modificar pedido', callbackData: 'rotiseria:modificar' },
              { text: '📅 Cambiar fecha', callbackData: 'rotiseria:fecha' },
            ],
          ],
        };
      }

      // 6. Nivel 1: Menú selector de períodos
      if (data === 'rotiseria:stats_menu') {
        return {
          text: '📈 *Estadísticas del Negocio*\n\nSeleccioná el período que querés consultar:',
          parseMode: 'Markdown',
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
      }

      // 7. Nivel 1: Selector de otros meses
      if (data === 'rotiseria:stats_ask_month') {
        const tz = ctx.tenant.business.timezone ?? 'America/Argentina/Buenos_Aires';
        const currentShift = getShiftDate(ctx.now, tz);
        const rows: InlineButton[][] = [];
        for (let i = 1; i <= 3; i++) {
          const d = new Date(Date.UTC(currentShift.getUTCFullYear(), currentShift.getUTCMonth() - i, 1));
          const y = d.getUTCFullYear();
          const m = String(d.getUTCMonth() + 1).padStart(2, '0');
          const label = d.toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
          const capitalized = label.charAt(0).toUpperCase() + label.slice(1);
          rows.push([{ text: `📆 ${capitalized}`, callbackData: `rotiseria:stats:mes:${y}-${m}` }]);
        }
        rows.push([{ text: '⬅️ Volver a períodos', callbackData: 'rotiseria:stats_menu' }]);

        return {
          text: '🗂️ *Seleccioná un mes anterior:*',
          parseMode: 'Markdown',
          inlineKeyboard: rows,
        };
      }

      // 8. Nivel 2: Métricas + Top 3 + Categorías
      if (data.startsWith('rotiseria:stats:')) {
        const period = data.slice('rotiseria:stats:'.length);
        const tz = ctx.tenant.business.timezone ?? 'America/Argentina/Buenos_Aires';
        const st = await sales.getStatsSummary(ctx.tenant.business.id, period, ctx.now, tz);

        const lines = [
          `📈 *Estadísticas — ${esc(st.periodLabel)}*`,
          '',
          `💰 Facturación neta: *${formatCurrency(st.salesTotal)}*`,
          `🧾 Cantidad de ventas: *${st.salesCount}* pedidos`,
          `🏷️ Ticket promedio: *${formatCurrency(st.averageTicket)}*`,
          st.cancelledCount > 0 ? `↩️ Pedidos anulados: *${st.cancelledCount}*` : '',
          '',
          '🏆 *Top 3 productos más vendidos:*',
        ];

        if (st.top3Products.length > 0) {
          for (const p of st.top3Products) {
            lines.push(`• ${esc(p.name)}: *${formatQty(p.quantity)}* u. — *${formatCurrency(p.subtotal)}*`);
          }
        } else {
          lines.push('• _Sin ventas registradas en este período_');
        }

        lines.push('', '📊 *Desglose por categorías:*');
        if (st.categories.length > 0) {
          for (const c of st.categories) {
            lines.push(
              `• ${getCategoryIcon(c.category)} *${esc(c.category)}*: ${formatQty(c.quantity)} u. — *${formatCurrency(c.subtotal)}*`
            );
          }
        } else {
          lines.push('• _Sin categorías en este período_');
        }

        const buttons: InlineButton[][] = [];
        if (st.categories.length > 0) {
          buttons.push([{ text: '🔍 Ver productos por categoría', callbackData: `rotiseria:catmenu:${period}` }]);
        }
        buttons.push([{ text: '⬅️ Volver a períodos', callbackData: 'rotiseria:stats_menu' }]);

        return {
          text: lines.filter(Boolean).join('\n'),
          parseMode: 'Markdown',
          inlineKeyboard: buttons,
        };
      }

      // 9. Nivel 3: Menú de categorías
      if (data.startsWith('rotiseria:catmenu:')) {
        const period = data.slice('rotiseria:catmenu:'.length);
        const tz = ctx.tenant.business.timezone ?? 'America/Argentina/Buenos_Aires';
        const st = await sales.getStatsSummary(ctx.tenant.business.id, period, ctx.now, tz);

        const buttons: InlineButton[][] = [];
        for (const c of st.categories) {
          const icon = getCategoryIcon(c.category);
          const catName = c.category.charAt(0).toUpperCase() + c.category.slice(1);
          buttons.push([
            {
              text: `${icon} ${catName} (${formatQty(c.quantity)} u.)`,
              callbackData: `rotiseria:catdetail:${period}:${c.category}`,
            },
          ]);
        }
        buttons.push([{ text: '⬅️ Volver al resumen', callbackData: `rotiseria:stats:${period}` }]);

        return {
          text: `🔍 *Categorías vendidas — ${esc(st.periodLabel)}*\n\nElegí una categoría para ver sus productos:`,
          parseMode: 'Markdown',
          inlineKeyboard: buttons,
        };
      }

      // 10. Nivel 3: Detalle de productos por categoría
      if (data.startsWith('rotiseria:catdetail:')) {
        const rest = data.slice('rotiseria:catdetail:'.length);
        const colonIdx = rest.indexOf(':');
        const period = rest.slice(0, colonIdx);
        const cat = rest.slice(colonIdx + 1);

        const tz = ctx.tenant.business.timezone ?? 'America/Argentina/Buenos_Aires';
        const st = await sales.getStatsSummary(ctx.tenant.business.id, period, ctx.now, tz);
        const prods = st.productsByCategory[cat] ?? [];
        const icon = getCategoryIcon(cat);
        const catName = cat.charAt(0).toUpperCase() + cat.slice(1);

        const lines = [
          `${icon} *Detalle: ${esc(catName)} — ${esc(st.periodLabel)}*`,
          '',
        ];

        if (prods.length > 0) {
          for (const p of prods) {
            lines.push(`• ${esc(p.name)}: *${formatQty(p.quantity)}* u. — *${formatCurrency(p.subtotal)}*`);
          }
        } else {
          lines.push('• _Sin ventas en esta categoría_');
        }

        return {
          text: lines.join('\n'),
          parseMode: 'Markdown',
          inlineKeyboard: [
            [{ text: '⬅️ Volver a categorías', callbackData: `rotiseria:catmenu:${period}` }],
            [{ text: '⬅️ Volver al resumen', callbackData: `rotiseria:stats:${period}` }],
          ],
        };
      }

      // 11. Anulación interactiva: anular última venta
      if (data === 'rotiseria:anular_ultima') {
        const sale = await sales.findLastActiveSale(ctx.tenant.business.id);
        if (!sale) {
          return { text: 'No hay ventas activas recientes para anular.', parseMode: 'Markdown' };
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
          text,
          parseMode: 'Markdown',
          inlineKeyboard: [
            [{ text: '✅ Sí, anular venta', callbackData: `rotiseria:anular_confirmar:${sale.id}` }],
            [{ text: '❌ No, volver', callbackData: 'rotiseria:anular_cancelar' }],
          ],
        };
      }

      // 12. Anulación interactiva: listar últimas 5
      if (data === 'rotiseria:anular_listar') {
        const recent = await sales.listRecentSales(ctx.tenant.business.id, 10);
        const active = recent.filter((s) => !s.isCancelled).slice(0, 5);
        if (active.length === 0) {
          return { text: 'No hay ventas activas recientes para anular.', parseMode: 'Markdown' };
        }
        const tz = ctx.tenant.business.timezone ?? 'America/Argentina/Buenos_Aires';
        const rows: InlineButton[][] = [];
        for (const s of active) {
          const num = formatSaleNumber(s.id);
          const label = `🛒 Venta #${num} (${formatCurrency(Number(s.total))} — ${formatTimeOnly(s.createdAt, tz)} hs)`;
          rows.push([{ text: label, callbackData: `rotiseria:anular_ver:${s.id}` }]);
        }
        rows.push([{ text: '❌ Cancelar', callbackData: 'rotiseria:anular_cancelar' }]);

        return {
          text: '📋 *Seleccioná la venta que querés anular:*',
          parseMode: 'Markdown',
          inlineKeyboard: rows,
        };
      }

      // 13. Anulación interactiva: ver venta elegida
      if (data.startsWith('rotiseria:anular_ver:')) {
        const id = data.slice('rotiseria:anular_ver:'.length);
        const sale = await sales.findSaleById(id, ctx.tenant.business.id);
        if (!sale || sale.isCancelled) {
          return { text: 'La venta seleccionada no está disponible o ya fue anulada.', parseMode: 'Markdown' };
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
          text,
          parseMode: 'Markdown',
          inlineKeyboard: [
            [{ text: '✅ Sí, anular venta', callbackData: `rotiseria:anular_confirmar:${sale.id}` }],
            [{ text: '❌ No, volver', callbackData: 'rotiseria:anular_cancelar' }],
          ],
        };
      }

      // 14. Anulación interactiva: confirmar anulación
      if (data.startsWith('rotiseria:anular_confirmar:')) {
        const id = data.slice('rotiseria:anular_confirmar:'.length);
        const cancelled = await sales.cancelSale(
          ctx.tenant.business.id,
          ctx.actorUserId,
          id,
          'Anulada por usuario desde menú interactivo',
          ctx.now
        );
        if (audit) {
          await audit.log({
            businessId: ctx.tenant.business.id,
            actorUserId: ctx.actorUserId,
            action: 'sale.cancelled',
            entityType: 'rotiseria_sale',
            entityId: cancelled.id,
            metadata: {
              motivo: 'Anulada por usuario desde menú interactivo',
              total: Number(cancelled.total),
            },
          });
        }
        const num = formatSaleNumber(cancelled.id);
        return {
          text: `✅ Venta #${num} anulada correctamente. El importe de *${formatCurrency(Number(cancelled.total))}* fue descontado de la caja.`,
          parseMode: 'Markdown',
        };
      }

      // 15. Anulación interactiva: cancelar
      if (data === 'rotiseria:anular_cancelar') {
        return {
          text: 'Operación cancelada. No se anuló ninguna venta.',
          parseMode: 'Markdown',
        };
      }

      // 16. Cambiar precio: volver a categorías
      if (data === 'rotiseria:price_cats') {
        const categories = await products.listActiveCategories(ctx.tenant.business.id);
        if (categories.length === 0) {
          return { text: 'Todavía no hay productos cargados en la carta.', parseMode: 'Markdown' };
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
          text: '🏷️ *Cambiar Precios*\n\nSeleccioná la categoría del producto que querés actualizar:',
          parseMode: 'Markdown',
          inlineKeyboard: rows,
        };
      }

      // 17. Cambiar precio: listar productos de la categoría
      if (data.startsWith('rotiseria:price_cat:')) {
        const cat = data.slice('rotiseria:price_cat:'.length);
        const prods = await products.listProducts(ctx.tenant.business.id, { category: cat });
        if (prods.length === 0) {
          return { text: `No hay productos activos en la categoría *${cat}*.`, parseMode: 'Markdown' };
        }
        const rows: InlineButton[][] = [];
        for (const p of prods) {
          const dozenStr = p.priceDozen ? ` / ${formatCurrency(Number(p.priceDozen))} doc.` : '';
          const label = `${p.name} (${formatCurrency(Number(p.priceUnit))} u.${dozenStr})`;
          rows.push([{ text: label, callbackData: `rotiseria:price_prod:${p.id}` }]);
        }
        rows.push([{ text: '⬅️ Volver a categorías', callbackData: 'rotiseria:price_cats' }]);

        const icon = getCategoryIcon(cat);
        const catName = cat.charAt(0).toUpperCase() + cat.slice(1);
        return {
          text: `🏷️ *Precios — ${icon} ${catName}*\n\nSeleccioná el producto a modificar:`,
          parseMode: 'Markdown',
          inlineKeyboard: rows,
        };
      }

      // 18. Cambiar precio: pedir nuevo valor
      if (data.startsWith('rotiseria:price_prod:')) {
        const prodId = data.slice('rotiseria:price_prod:'.length);
        const prod = await products.findProductById(prodId, ctx.tenant.business.id);
        if (!prod) {
          return { text: 'Producto no encontrado.', parseMode: 'Markdown' };
        }

        if (conversations) {
          await conversations.upsert({
            businessId: ctx.tenant.business.id,
            userId: ctx.actorUserId,
            phase: 'COLLECTING',
            actionName: 'cambiar_precio',
            data: {
              _awaitingPriceForProductId: prod.id,
              productName: prod.name,
              currentPriceUnit: Number(prod.priceUnit),
              currentPriceDozen: prod.priceDozen ? Number(prod.priceDozen) : null,
            },
            expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
            updatedAt: ctx.now,
          });
        }

        return {
          text: `Ingresá el nuevo precio unitario para *${esc(prod.name)}* (Precio actual: *${formatCurrency(Number(prod.priceUnit))}*). Si tiene precio por docena, ingresalo separado por una barra (ej: \`1400\` o \`1400 / 16000\`).`,
          parseMode: 'Markdown',
        };
      }

      // 19. Cambiar precio: cancelar
      if (data === 'rotiseria:price_cancel') {
        if (conversations) {
          await conversations.clear(ctx.tenant.business.id, ctx.actorUserId);
        }
        return { text: 'Operación cancelada.', parseMode: 'Markdown' };
      }

      // 20. Control de días: volver al semáforo
      if (data === 'rotiseria:control_dias_back') {
        const tz = ctx.tenant.business.timezone ?? 'America/Argentina/Buenos_Aires';
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
        return { text: lines.join('\n'), parseMode: 'Markdown', inlineKeyboard: buttons };
      }

      // 21. Control de días: ver detalle comanda por comanda
      if (data.startsWith('rotiseria:ver_dia:')) {
        const iso = data.slice('rotiseria:ver_dia:'.length);
        const targetDate = new Date(`${iso}T00:00:00.000Z`);
        const tz = ctx.tenant.business.timezone ?? 'America/Argentina/Buenos_Aires';
        const daySales = await sales.findByShiftDate(ctx.tenant.business.id, targetDate);
        const activeSales = daySales
          .filter((s) => !s.isCancelled)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        const totalRecaudado = activeSales.reduce((acc, s) => acc + Number(s.total), 0);
        const lines: string[] = [
          `📅 Detalle del ${formatRealDateWithDay(targetDate)}`,
          `📊 *${activeSales.length}* ventas | Total recaudado: *${formatCurrency(totalRecaudado)}*`,
          '',
        ];

        if (activeSales.length === 0) {
          lines.push('_Sin ventas activas en esta jornada._');
        } else {
          for (const sale of activeSales) {
            const num = formatSaleNumber(sale.id);
            lines.push(`🕒 ${formatTimeOnly(sale.createdAt, tz)} (Venta #${num}) — *${formatCurrency(Number(sale.total))}*`);
            for (const item of sale.items) {
              lines.push(`  • ${formatQty(Number(item.quantity))}x ${esc(item.name)}`);
            }
          }
        }

        return {
          text: lines.join('\n'),
          parseMode: 'Markdown',
          inlineKeyboard: [
            [
              { text: '⬅️ Volver al control de días', callbackData: 'rotiseria:control_dias_back' },
              { text: '❌ Cerrar', callbackData: 'rotiseria:cerrar' },
            ],
          ],
        };
      }

      // 22. Cerrar diálogo
      if (data === 'rotiseria:cerrar') {
        return { text: 'Operación cerrada.', parseMode: 'Markdown' };
      }

      return null;
    },
  };

  return {
    template,
    seedBusiness: async (businessId: string) => {
      await products.seedBaseCatalog(businessId);
    },
  };
}
