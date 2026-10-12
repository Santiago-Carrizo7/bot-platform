import type { PrismaClient } from '@prisma/client';
import type {
  BotReply,
  CommandDef,
  InlineButton,
  TemplateDefinition,
} from '../../core/actions/registry.js';
import { ProductRepository } from './persistence/product.repo.js';
import { SaleRepository } from './persistence/sale.repo.js';
import { DeliveryZoneRepository } from './persistence/delivery-zone.repo.js';
import { ProductService } from './domain/product.service.js';
import { SaleService } from './domain/sale.service.js';
import { StatsService } from './domain/stats.service.js';
import { DeliveryZoneService } from './domain/delivery-zone.service.js';
import { buildRotiseriaActions, ROTISERIA_MENU_HELP_TEXT } from './actions.js';
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
  formatDeliveryStatsSummary,
} from './format.js';
import { calculatePricing } from './domain/pricing.js';
import { getShiftDate } from './domain/shift.js';
import { applyModification, parseModificationText } from './domain/modification.js';

export function parseDeliveryZonesBatchText(
  text: string
): Array<{ nombre: string; precio: number; barrios: string[] }> {
  const chunks = text.includes('\n')
    ? text.split('\n')
    : text.includes(';')
    ? text.split(';')
    : [text];
  const lines = chunks.map((l) => l.trim()).filter(Boolean);
  const result: Array<{ nombre: string; precio: number; barrios: string[] }> = [];

  for (const line of lines) {
    const m = line.match(
      /^([^:\-\d]+?)\s*[:\-]\s*(?:[\$\s]*)(gratis|\d+(?:[.,]\d+)?)(?:\s*(?:[\(\-])\s*(?:barrios:?\s*)?([^\)\-]+)\)?)?/i
    );
    if (m) {
      const nombre = m[1].trim();
      const rawPrice = m[2].trim().toLowerCase();
      const precio = rawPrice === 'gratis' ? 0 : parseFloat(rawPrice.replace(',', '.'));
      const barrios = m[3]
        ? m[3]
            .split(',')
            .map((b) => b.trim().toLowerCase())
            .filter(Boolean)
        : [];
      if (nombre && !isNaN(precio)) {
        result.push({ nombre, precio, barrios });
        continue;
      }
    }

    // Patrón "Zona / Barrios a 2500" o "Zona a gratis"
    const mA = line.match(
      /^([^:\-\d]+?)\s+a\s+(?:[\$\s]*)(gratis|\d+(?:[.,]\d+)?)(?:\s*(?:[\(\-])\s*(?:barrios:?\s*)?([^\)\-]+)\)?)?/i
    );
    if (mA) {
      const rawNombre = mA[1].trim();
      const rawPrice = mA[2].trim().toLowerCase();
      const precio = rawPrice === 'gratis' ? 0 : parseFloat(rawPrice.replace(',', '.'));
      const barriosFromGroup = rawNombre
        .split(/,|\by\b/i)
        .map((b) => b.trim().toLowerCase())
        .filter(Boolean);
      const extraBarrios = mA[3]
        ? mA[3]
            .split(',')
            .map((b) => b.trim().toLowerCase())
            .filter(Boolean)
        : [];
      const allBarrios = Array.from(new Set([...barriosFromGroup, ...extraBarrios]));
      const mainName = rawNombre.split(/,|\by\b/i)[0].trim();
      if (mainName && !isNaN(precio)) {
        result.push({ nombre: mainName, precio, barrios: allBarrios });
        continue;
      }
    }

    const m2 = line.match(/^([A-Za-zÁÉÍÓÚáéíóúñÑ\s]+?)\s+(?:[\$\s]*)(\d+(?:[.,]\d+)?)$/);
    if (m2) {
      const nombre = m2[1].trim();
      const precio = parseFloat(m2[2].replace(',', '.'));
      if (nombre && !isNaN(precio)) {
        result.push({ nombre, precio, barrios: [] });
      }
    }
  }

  return result;
}

export function parseBebidasBatchText(
  text: string
): Array<{ nombre: string; precio: number }> {
  const chunks = text.includes('\n')
    ? text.split('\n')
    : text.includes(';')
    ? text.split(';')
    : text.includes(',')
    ? text.split(',')
    : [text];
  const lines = chunks.map((l) => l.trim()).filter(Boolean);
  const result: Array<{ nombre: string; precio: number }> = [];

  for (const line of lines) {
    // 1. Patrón con separador colon o guión o "a": "Coca 1.5L : 3500", "Fanta 1.5L - 3500", "Cerveza 1L a 4000"
    const m = line.match(/^([^:\-]+?)\s*(?:[:\-]|(?:\s+a\s+))\s*(?:[\$\s]*)(\d+(?:[.,]\d+)?)$/i);
    if (m) {
      const nombre = m[1].trim();
      const precio = parseFloat(m[2].replace(',', '.'));
      if (nombre && !isNaN(precio) && precio > 0) {
        result.push({ nombre, precio });
        continue;
      }
    }

    // 2. Patrón de espacio antes del número: "Coca 1.5L 3500", "Agua 500ml 1500"
    const m2 = line.match(/^(.*?)\s+(?:[\$\s]*)(\d+(?:[.,]\d+)?)$/);
    if (m2) {
      const nombre = m2[1].trim();
      const precio = parseFloat(m2[2].replace(',', '.'));
      if (nombre && !isNaN(precio) && precio > 0) {
        result.push({ nombre, precio });
        continue;
      }
    }
  }

  return result;
}

export interface RotiseriaTemplateDeps {
  db: PrismaClient;
  products?: ProductService;
  sales?: SaleService;
  deliveryZones?: DeliveryZoneService;
}

export interface RotiseriaTemplateBundle {
  template: TemplateDefinition;
  seedBusiness: (businessId: string) => Promise<void>;
}

const COMMANDS: CommandDef[] = [
  { command: 'venta', description: '📝 Registrar venta', action: 'registrar_venta' },
  { command: 'promo', description: '🎁 Gestionar promociones', action: 'crear_editar_promo' },
  { command: 'comida', description: '➕ Crear comida', action: 'crear_producto' },
  { command: 'precio', description: '🏷️ Modificar precios de la carta', action: 'cambiar_precio' },
  { command: 'envios', description: '🛵 Envíos a domicilio y tarifas', action: 'gestionar_envios' },
  { command: 'dias', description: '📅 Control de días recientes', action: 'control_dias' },
  { command: 'estadisticas', description: '📈 Estadísticas de ventas', action: 'menu_estadisticas' },
  { command: 'ventas', description: '🧾 Últimas ventas registradas', action: 'consultar_ventas' },
  { command: 'anular', description: '↩️ Anular última venta', action: 'anular_venta' },
  { command: 'carta', description: '📋 Ver carta y promociones vigentes', action: 'consultar_carta' },
  { command: 'stats', description: '📈 Estadísticas de ventas', action: 'menu_estadisticas' },
  { command: 'menu', description: '✨ Funcionalidades disponibles', action: 'mostrar_menu', reply: ROTISERIA_MENU_HELP_TEXT },
  { command: 'producto', description: '➕ Crear comida', action: 'crear_producto' },
  { command: 'bebidas', description: '🥤 Bebidas y refrescos', action: 'gestionar_bebidas' },
];

export function createRotiseriaTemplate(deps: RotiseriaTemplateDeps): RotiseriaTemplateBundle {
  const productRepo = new ProductRepository(deps.db);
  const saleRepo = new SaleRepository(deps.db);
  const deliveryZoneRepo = new DeliveryZoneRepository(deps.db);

  const products = deps.products ?? new ProductService(productRepo);
  const stats = new StatsService(saleRepo);
  const sales = deps.sales ?? new SaleService(saleRepo, products, stats);
  const deliveryZones = deps.deliveryZones ?? new DeliveryZoneService(deliveryZoneRepo);

  const template: TemplateDefinition = {
    id: 'rotiseria',
    label: 'Rotisería / Sándwiches y Empanadas',
    welcome: (businessName) =>
      [
        '👋 ¡Hola! Qué lindo tenerte por acá.',
        '',
        `Soy tu asistente para *${businessName}*, y estoy listo para darte una mano en la hora pico para que atiendas rápido y no te compliques con las cuentas.`,
        '',
        '🎙️ *¿Cómo funciona? Es muy fácil:*',
        'Mandame un audio o escribime tal cual te piden los clientes por WhatsApp:',
        '👉 _"1 docena de carne y una de pollo con envío a Tres Cerritos"_',
        '',
        'Yo me encargo de armarte el cálculo de las docenas, sumar el delivery y dejarte la cuenta lista para cobrar.',
        '',
        'Abajo te dejo los botones rápidos para que los uses cuando quieras 👇',
      ].join('\n'),
    systemPrompt: (businessName, referenceDate, hints) =>
      buildRotiseriaSystemPrompt(businessName, referenceDate, hints),
    resolveHints: async (tenant) => {
      const [productList, promoList, zoneList] = await Promise.all([
        products.listProducts(tenant.business.id, { limit: 100 }),
        products.listPromos(tenant.business.id),
        deliveryZones.listActive(tenant.business.id),
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
      if (zoneList.length > 0) {
        lines.push('Zonas de envío:');
        for (const z of zoneList) {
          const fee = z.price === 0 ? 'gratis ($0)' : formatCurrency(z.price);
          const barrios = z.barrios.length > 0 ? ` (barrios: ${z.barrios.join(', ')})` : '';
          lines.push(`- Zona "${z.name}": flete ${fee}${barrios}`);
        }
      }

      if (lines.length === 0) return '';
      return lines.join('\n').slice(0, 1800);
    },
    actions: buildRotiseriaActions({ products, sales, deliveryZones }),
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
        if ((activeData?._awaitingModification || activeData?._modifying) && Array.isArray(activeData.items)) {
          const currentItems = activeData.items.map((it: any) => ({
            name: String(it.nombre ?? it.name),
            quantity: Number(it.cantidad ?? it.quantity),
            unitPrice: it.precio_unitario !== undefined && it.precio_unitario !== null ? Number(it.precio_unitario) : undefined,
          }));
          const patch = parseModificationText(trimmed, currentItems);
          if (patch) {
            const updated = applyModification(currentItems, patch);
            if (updated.length > 0) {
              const {
                _awaitingModification: _dropAwaitingMod,
                _modifying: _dropMod,
                _uncataloguedZeroItems: _dropUncat,
                no_reconocidos: _dropNoRec,
                ...restParams
              } = activeData;
              return {
                actionName: 'registrar_venta',
                params: {
                  ...restParams,
                  items: updated.map((it) => ({
                    nombre: it.name,
                    cantidad: it.quantity,
                    precio_unitario: (it as any).unitPrice,
                  })),
                  _modifying: true,
                  _awaitingModification: false,
                  no_reconocidos: undefined,
                  _uncataloguedZeroItems: undefined,
                },
              };
            }
          }
        }

        // Ingreso manual de precio unitario para un ítem no catalogado / especial
        if (activeData?._awaitingItemPriceFor !== undefined && activeData._awaitingItemPriceFor !== null) {
          const targetIndex = typeof activeData._awaitingItemPriceIndex === 'number' ? activeData._awaitingItemPriceIndex : -1;
          const targetName = String(activeData._awaitingItemPriceFor).toLowerCase().trim();
          const lower = trimmed.toLowerCase();
          let price: number | null = null;
          if (lower.includes('gratis') || lower === '0') {
            price = 0;
          } else {
            const clean = lower.replace(/\$/g, '').trim();
            if (clean.endsWith('k')) {
              const base = parseFloat(clean.slice(0, -1).replace(',', '.'));
              if (!isNaN(base)) price = Math.round(base * 1000);
            } else {
              const numStr = clean.replace(/[^0-9.,]/g, '').replace(',', '.');
              const parsed = parseFloat(numStr);
              if (!isNaN(parsed) && parsed >= 0) price = parsed;
            }
          }

          if (price !== null) {
            const currentItems = Array.isArray(activeData.items)
              ? activeData.items.map((it: any) => ({
                  nombre: String(it.nombre ?? it.name),
                  cantidad: Number(it.cantidad ?? it.quantity),
                  precio_unitario: it.precio_unitario !== undefined && it.precio_unitario !== null ? Number(it.precio_unitario) : undefined,
                }))
              : [];

            let foundIdx = targetIndex >= 0 && targetIndex < currentItems.length ? targetIndex : -1;
            if (foundIdx < 0) {
              foundIdx = currentItems.findIndex(
                (it) => it.nombre.toLowerCase().trim() === targetName
              );
            }

            if (foundIdx >= 0) {
              currentItems[foundIdx].precio_unitario = price;
            }

            return {
              actionName: 'registrar_venta',
              params: {
                ...activeData,
                items: currentItems,
                _awaitingItemPriceIndex: null,
                _awaitingItemPriceFor: null,
              },
            };
          }
        }

        // Ingreso manual de flete cuando se esperaba monto para una zona o flete directo
        if (activeData?._awaitingManualFee) {
          const clean = trimmed.toLowerCase().replace(/[^0-9.,]/g, '').replace(',', '.');
          let fee: number | null = null;
          if (trimmed.toLowerCase().includes('gratis') || trimmed === '0') {
            fee = 0;
          } else if (clean) {
            const parsed = parseFloat(clean);
            if (!isNaN(parsed) && parsed >= 0) fee = parsed;
          }

          if (fee !== null) {
            return {
              actionName: 'registrar_venta',
              params: {
                flete_monto: fee,
                zona_envio: String(activeData.zona_envio ?? activeData.zona_no_reconocida ?? 'Envío'),
                zona_no_reconocida: undefined,
                _awaitingManualFee: false,
              },
            };
          }
        }

        // Ingreso de zona / flete / retiro en local
        if (activeData?._awaitingDelivery) {
          const lower = trimmed.toLowerCase();
          if (
            lower.includes('sin envio') ||
            lower.includes('sin flete') ||
            lower.includes('mostrador') ||
            lower.includes('retira') ||
            lower.includes('local') ||
            lower.includes('sacar') ||
            lower === '0' ||
            lower === 'gratis'
          ) {
            if (lower === '0' || lower === 'gratis' || lower.includes('gratis')) {
              return {
                actionName: 'registrar_venta',
                params: {
                  flete_monto: 0,
                  zona_envio: 'Envío',
                  zona_no_reconocida: null,
                  _awaitingDelivery: false,
                },
              };
            }
            return {
              actionName: 'registrar_venta',
              params: {
                flete_monto: null,
                zona_envio: null,
                zona_no_reconocida: null,
                _awaitingDelivery: false,
              },
            };
          }

          const cleanNum = lower.replace(/[^0-9.,]/g, '').replace(',', '.');
          const parsedNum = parseFloat(cleanNum);
          if (!isNaN(parsedNum) && parsedNum > 0 && !lower.match(/[a-záéíóúñ]/)) {
            return {
              actionName: 'registrar_venta',
              params: {
                flete_monto: parsedNum,
                zona_envio: 'Envío',
                zona_no_reconocida: null,
                _awaitingDelivery: false,
              },
            };
          }

          return {
            actionName: 'registrar_venta',
            params: {
              zona_envio: trimmed,
              flete_monto: undefined,
              zona_no_reconocida: null,
              _awaitingDelivery: false,
            },
          };
        }
      }

      // Carga de zonas de envío en lote
      if (activeActionName === 'configurar_envios_lote') {
        const parsedZones = parseDeliveryZonesBatchText(trimmed);
        if (parsedZones.length > 0) {
          return {
            actionName: 'configurar_envios_lote',
            params: { zonas: parsedZones },
          };
        }
      }

      // Carga de bebidas en lote
      if (activeActionName === 'configurar_bebidas_lote') {
        const parsedBebidas = parseBebidasBatchText(trimmed);
        if (parsedBebidas.length > 0) {
          return {
            actionName: 'configurar_bebidas_lote',
            params: { bebidas: parsedBebidas },
          };
        }
      }

      // Ingreso de nuevo precio para una bebida
      if (activeActionName === 'gestionar_bebidas' && activeData?._awaitingDrinkPriceId) {
        const cleanNum = trimmed.replace(/[^0-9.,]/g, '').replace(',', '.');
        const parsed = parseFloat(cleanNum);
        if (!isNaN(parsed) && parsed > 0) {
          return {
            actionName: 'gestionar_bebidas',
            params: {
              product_id: String(activeData._awaitingDrinkPriceId),
              nuevo_precio: parsed,
            },
          };
        }
      }

      // Ingreso de nuevo precio para una zona de envío
      if (activeActionName === 'gestionar_envios' && activeData?._awaitingZonePriceId) {
        const lower = trimmed.toLowerCase();
        let newPrice: number | null = null;
        if (lower.includes('gratis') || lower === '0') {
          newPrice = 0;
        } else {
          const cleanNum = lower.replace(/[^0-9.,]/g, '').replace(',', '.');
          const parsed = parseFloat(cleanNum);
          if (!isNaN(parsed) && parsed >= 0) newPrice = parsed;
        }

        if (newPrice !== null) {
          return {
            actionName: 'gestionar_envios',
            params: {
              zone_id: String(activeData._awaitingZonePriceId),
              nuevo_precio: newPrice,
            },
          };
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

      // Gestión de promociones interactiva
      if (activeActionName === 'crear_editar_promo') {
        if (activeData?._awaitingPromoPriceId) {
          const cleanNum = trimmed.replace(/[^0-9.,]/g, '').replace(',', '.');
          const val = parseFloat(cleanNum);
          if (!isNaN(val) && val > 0) {
            return {
              actionName: 'crear_editar_promo',
              params: {
                promo_id: String(activeData._awaitingPromoPriceId),
                precio: val,
              },
            };
          }
        }

        if (activeData?._awaitingPromoDescId) {
          return {
            actionName: 'crear_editar_promo',
            params: {
              promo_id: String(activeData._awaitingPromoDescId),
              descripcion: trimmed === '-' ? '' : trimmed,
            },
          };
        }

        if (activeData?._creatingPromo) {
          const delimiter = trimmed.includes('|') ? '|' : trimmed.includes('/') ? '/' : null;
          if (delimiter) {
            const parts = trimmed.split(delimiter).map((p) => p.trim());
            if (parts.length >= 2) {
              const name = parts[0];
              const price = parseFloat(parts[1].replace(/[^0-9.,]/g, '').replace(',', '.'));
              const desc = parts[2] || undefined;
              if (name && !isNaN(price) && price > 0) {
                return {
                  actionName: 'crear_editar_promo',
                  params: {
                    nombre: name,
                    precio: price,
                    descripcion: desc,
                  },
                };
              }
            }
          }
        }
      }

      if (trimmed.toLowerCase() === 'menu' || trimmed.toLowerCase() === '/menu') {
        return { actionName: 'mostrar_menu', params: {} };
      }
      if (trimmed.toLowerCase() === 'carta' || trimmed.toLowerCase() === '/carta') {
        return { actionName: 'consultar_carta', params: {} };
      }
      if (trimmed.toLowerCase() === 'bebidas' || trimmed.toLowerCase() === '/bebidas') {
        return { actionName: 'gestionar_bebidas', params: {} };
      }
      if (trimmed.toLowerCase() === 'envios' || trimmed.toLowerCase() === '/envios') {
        return { actionName: 'gestionar_envios', params: {} };
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
      { label: '🎁 Gestionar promociones', action: 'crear_editar_promo' },
      { label: '📅 Control de días recientes', action: 'control_dias' },
      { label: '📈 Estadísticas de ventas', action: 'menu_estadisticas' },
      { label: '↩️ Anular última venta', action: 'anular_venta' },
      { label: '🏷️ Modificar precios de la carta', action: 'cambiar_precio' },
      { label: '🛵 Envíos', action: 'gestionar_envios' },
      { label: '🥤 Bebidas', action: 'gestionar_bebidas' },
      { label: '📋 Ver carta y promociones vigentes', action: 'consultar_carta' },
      { label: '🧾 Últimas ventas registradas', action: 'consultar_ventas' },
      { label: '➕ Crear comida', action: 'crear_producto' },
    ],
    menuCommands: [
      { command: 'venta', description: '📝 Registrar venta' },
      { command: 'promo', description: '🎁 Gestionar promociones' },
      { command: 'comida', description: '➕ Crear comida' },
      { command: 'precio', description: '🏷️ Modificar precios de la carta' },
      { command: 'envios', description: '🛵 Envíos a domicilio y tarifas' },
      { command: 'bebidas', description: '🥤 Bebidas y refrescos' },
      { command: 'dias', description: '📅 Control de días recientes' },
      { command: 'estadisticas', description: '📈 Estadísticas de ventas' },
      { command: 'ventas', description: '🧾 Últimas ventas registradas' },
      { command: 'anular', description: '↩️ Anular última venta' },
      { command: 'carta', description: '📋 Ver carta y promociones vigentes' },
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
              _awaitingModification: true,
            },
            expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
            updatedAt: ctx.now,
          });
        }

        const modifyButtons: InlineButton[][] = [];
        if (items.length > 0) {
          items.forEach((it: any, idx: number) => {
            const itName = String(it.nombre ?? it.name);
            modifyButtons.push([
              {
                text: `❌ Quitar ${itName.slice(0, 22)}`,
                callbackData: `rotiseria:quitar_linea:${idx}`,
              },
            ]);
          });
        }
        modifyButtons.push([{ text: '↩️ Volver al pedido', callbackData: 'rotiseria:volver_confirm' }]);

        return {
          text: `${cleanSummary}\n\n¿Qué modificamos o agregamos? Podés sumar productos, cambiar cantidades o sacar ítems (ej: *"sacá la pizza"* o *"cambiá las 12 de carne por pollo"*).`,
          parseMode: 'Markdown',
          inlineKeyboard: modifyButtons,
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

        if (st.promosSummary && st.promosSummary.promos.length > 0) {
          lines.push('', '🎁 *Promos vendidas:*');
          for (const pr of st.promosSummary.promos) {
            lines.push(`• *${esc(pr.name)}*: ${formatQty(pr.quantity)} u. — *${formatCurrency(pr.subtotal)}*`);
          }
          lines.push(
            `Total combos: *${formatQty(st.promosSummary.totalQuantity)}* u. (*${formatCurrency(st.promosSummary.totalAmount)}*)`
          );
        }

        const buttons: InlineButton[][] = [];
        if (st.categories.length > 0) {
          buttons.push([{ text: '🔍 Ver productos por categoría', callbackData: `rotiseria:catmenu:${period}` }]);
        }
        buttons.push([{ text: '🛵 Ver ranking de envíos', callbackData: 'rotiseria:envios_stats' }]);
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

      // 12. Anulación interactiva: listar ventas (5 o 10)
      if (data === 'rotiseria:anular_listar' || data.startsWith('rotiseria:anular_listar:')) {
        const rawLimit = data.startsWith('rotiseria:anular_listar:')
          ? parseInt(data.slice('rotiseria:anular_listar:'.length), 10)
          : 10;
        const limit = !isNaN(rawLimit) && rawLimit > 0 ? rawLimit : 10;
        const recent = await sales.listRecentSales(ctx.tenant.business.id, limit);
        if (recent.length === 0) {
          return { text: 'No hay ventas recientes para anular.', parseMode: 'Markdown' };
        }
        const tz = ctx.tenant.business.timezone ?? 'America/Argentina/Buenos_Aires';
        const rows: InlineButton[][] = [];
        for (const s of recent) {
          const num = formatSaleNumber(s.id);
          const time = formatTimeOnly(s.createdAt, tz);
          const totalStr = formatCurrency(Number(s.total));
          if (s.isCancelled) {
            rows.push([{ text: `❌ #${num} — ${totalStr} (ANULADA - ${time} hs)`, callbackData: 'rotiseria:anular_ya_anulada' }]);
          } else {
            rows.push([{ text: `↩️ #${num} — ${totalStr} (${time} hs)`, callbackData: `rotiseria:anular_ver:${s.id}` }]);
          }
        }
        rows.push([{ text: '❌ Cancelar', callbackData: 'rotiseria:anular_cancelar' }]);

        const title = data.startsWith('rotiseria:anular_listar:')
          ? `📋 *Seleccioná la venta que querés anular (últimas ${limit}):*`
          : '📋 *Seleccioná la venta que querés anular:*';

        return {
          text: title,
          parseMode: 'Markdown',
          inlineKeyboard: rows,
        };
      }

      if (data === 'rotiseria:anular_ya_anulada') {
        return {
          text: 'Esta venta ya se encuentra anulada y no puede volver a anularse.',
          parseMode: 'Markdown',
        };
      }

      // 13. Anulación interactiva: ver venta elegida
      if (data.startsWith('rotiseria:anular_ver:') || data.startsWith('rotiseria:anular_pedido:')) {
        const id = data.startsWith('rotiseria:anular_ver:')
          ? data.slice('rotiseria:anular_ver:'.length)
          : data.slice('rotiseria:anular_pedido:'.length);
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

      // 23. Desambiguación: resolver ítem sugerido
      if (data.startsWith('rotiseria:resolver:')) {
        const parts = data.slice('rotiseria:resolver:'.length).split(':');
        const sugerenciaName = decodeURIComponent(parts[0]);
        const cant = parseInt(parts[1] || '1', 10) || 1;

        const currentData = (activeState?.data ?? {}) as Record<string, unknown>;
        const currentItems: Array<{ nombre: string; cantidad: number }> = Array.isArray(currentData.items)
          ? currentData.items.map((it: any) => ({
              nombre: String(it.nombre ?? it.name),
              cantidad: Number(it.cantidad ?? it.quantity),
            }))
          : [];

        const catalog = await products.getCatalogLookup(ctx.tenant.business.id);
        const resolvedProduct = catalog.findProduct(sugerenciaName);
        const resolvedPromo = !resolvedProduct ? catalog.findPromo(sugerenciaName) : null;
        const resolvedExactName = resolvedProduct ? resolvedProduct.name : resolvedPromo ? resolvedPromo.name : sugerenciaName;

        const existingIdx = currentItems.findIndex(
          (it) => it.nombre.toLowerCase() === resolvedExactName.toLowerCase()
        );
        if (existingIdx >= 0) {
          currentItems[existingIdx].cantidad += cant;
        } else {
          currentItems.push({ nombre: resolvedExactName, cantidad: cant });
        }

        const currentNoRec: any[] = Array.isArray(currentData.no_reconocidos) ? [...currentData.no_reconocidos] : [];
        const recIdx = currentNoRec.findIndex((n) => {
          const sug = typeof n === 'object' && n !== null ? n.sugerencia : null;
          return sug && String(sug).toLowerCase() === sugerenciaName.toLowerCase();
        });
        if (recIdx >= 0) {
          currentNoRec.splice(recIdx, 1);
        }

        const pricing = calculatePricing(
          currentItems.map((it) => ({ name: it.nombre, quantity: it.cantidad })),
          catalog
        );

        const updatedData: Record<string, unknown> = {
          ...currentData,
          items: currentItems,
          no_reconocidos: currentNoRec,
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

        const summaryText = formatSaleSummary({
          items: currentItems,
          nota: updatedData.nota as string | undefined,
          fecha: updatedData.fecha as string | undefined,
          breakdown: pricing.breakdown,
          total: pricing.total,
          isModifying: false,
          now: ctx.now,
          timezone: ctx.tenant.business.timezone,
          noReconocidos: currentNoRec,
        });

        const actionReg = template.actions.find((a) => a.name === 'registrar_venta');
        const keyboard = actionReg?.confirmButtons ? actionReg.confirmButtons(updatedData) : undefined;

        return {
          text: summaryText,
          parseMode: 'Markdown',
          inlineKeyboard: keyboard,
        };
      }

      // 24. Desambiguación: ignorar ítem no reconocido
      if (data.startsWith('rotiseria:ignorar:')) {
        const idx = parseInt(data.slice('rotiseria:ignorar:'.length), 10);
        const currentData = (activeState?.data ?? {}) as Record<string, unknown>;
        const currentItems: Array<{ nombre: string; cantidad: number }> = Array.isArray(currentData.items)
          ? currentData.items.map((it: any) => ({
              nombre: String(it.nombre ?? it.name),
              cantidad: Number(it.cantidad ?? it.quantity),
            }))
          : [];
        const currentNoRec: any[] = Array.isArray(currentData.no_reconocidos) ? [...currentData.no_reconocidos] : [];

        if (idx >= 0 && idx < currentNoRec.length) {
          currentNoRec.splice(idx, 1);
        }

        const hasSuggestionsLeft = currentNoRec.some((n) => typeof n === 'object' && n !== null && n.sugerencia);
        if (currentItems.length === 0 && !hasSuggestionsLeft) {
          if (conversations) {
            await conversations.clear(ctx.tenant.business.id, ctx.actorUserId);
          }
          return {
            text: '❌ Pedido cancelado al no contener productos de la carta.',
            parseMode: 'Markdown',
          };
        }

        let breakdown: string[] | undefined;
        let total: number | undefined;
        try {
          const catalog = await products.getCatalogLookup(ctx.tenant.business.id);
          if (currentItems.length > 0) {
            const pricing = calculatePricing(
              currentItems.map((it) => ({ name: it.nombre, quantity: it.cantidad })),
              catalog
            );
            breakdown = pricing.breakdown;
            total = pricing.total;
          }
        } catch {
          // fallback
        }

        const updatedData: Record<string, unknown> = {
          ...currentData,
          items: currentItems,
          no_reconocidos: currentNoRec,
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

        const summaryText = formatSaleSummary({
          items: currentItems,
          nota: updatedData.nota as string | undefined,
          fecha: updatedData.fecha as string | undefined,
          breakdown,
          total,
          isModifying: false,
          now: ctx.now,
          timezone: ctx.tenant.business.timezone,
          noReconocidos: currentNoRec,
        });

        const actionReg = template.actions.find((a) => a.name === 'registrar_venta');
        const keyboard = actionReg?.confirmButtons ? actionReg.confirmButtons(updatedData) : undefined;

        return {
          text: summaryText,
          parseMode: 'Markdown',
          inlineKeyboard: keyboard,
        };
      }

      // 25. Promos: nueva promo
      if (data === 'rotiseria:promo:nueva') {
        if (conversations) {
          await conversations.upsert({
            businessId: ctx.tenant.business.id,
            userId: ctx.actorUserId,
            phase: 'COLLECTING',
            actionName: 'crear_editar_promo',
            data: { _creatingPromo: true },
            expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
            updatedAt: ctx.now,
          });
        }
        return {
          text: '🎁 *Nueva Promoción*\n\nEscribí los datos en formato:\n`Nombre | Precio | Descripción (opcional)`\n\nPor ejemplo:\n`Promo 2 | 18000 | 1 Pizza Especial + 6 Empanadas`',
          parseMode: 'Markdown',
        };
      }

      // 26. Promos: ver / editar ficha
      if (data.startsWith('rotiseria:promo:editar:')) {
        const id = data.slice('rotiseria:promo:editar:'.length);
        const promo = await products.findPromoById(id, ctx.tenant.business.id);
        if (!promo) {
          return { text: 'Promo no encontrada.', parseMode: 'Markdown' };
        }
        const statusText = promo.isActive ? '🟢 Activa' : '⏸️ Pausada';
        const descText = promo.description ? `_${esc(promo.description)}_` : '_(Sin descripción)_';
        const card = [
          `🎁 *Promo: ${esc(promo.name)}*`,
          '',
          `💰 Precio: *${formatCurrency(Number(promo.price))}*`,
          `📝 Detalle: ${descText}`,
          `📌 Estado: *${statusText}*`,
        ].join('\n');

        const buttons: InlineButton[][] = [
          [
            { text: '💵 Cambiar precio', callbackData: `rotiseria:promo:edit_price:${promo.id}` },
            { text: '📝 Cambiar descripción', callbackData: `rotiseria:promo:edit_desc:${promo.id}` },
          ],
          [
            promo.isActive
              ? { text: '🚫 Pausar / Desactivar', callbackData: `rotiseria:promo:deactivate:${promo.id}` }
              : { text: '▶️ Reactivar', callbackData: `rotiseria:promo:activate:${promo.id}` },
          ],
          [{ text: '⬅️ Volver a promos', callbackData: 'rotiseria:promo:listar' }],
        ];

        return {
          text: card,
          parseMode: 'Markdown',
          inlineKeyboard: buttons,
        };
      }

      // 27. Promos: pedir nuevo precio
      if (data.startsWith('rotiseria:promo:edit_price:')) {
        const id = data.slice('rotiseria:promo:edit_price:'.length);
        const promo = await products.findPromoById(id, ctx.tenant.business.id);
        if (!promo) return { text: 'Promo no encontrada.', parseMode: 'Markdown' };

        if (conversations) {
          await conversations.upsert({
            businessId: ctx.tenant.business.id,
            userId: ctx.actorUserId,
            phase: 'COLLECTING',
            actionName: 'crear_editar_promo',
            data: { _awaitingPromoPriceId: promo.id, promoName: promo.name },
            expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
            updatedAt: ctx.now,
          });
        }
        return {
          text: `💵 Ingresá el nuevo precio para *${esc(promo.name)}* (actual: *${formatCurrency(Number(promo.price))}*):`,
          parseMode: 'Markdown',
        };
      }

      // 28. Promos: pedir nueva descripción
      if (data.startsWith('rotiseria:promo:edit_desc:')) {
        const id = data.slice('rotiseria:promo:edit_desc:'.length);
        const promo = await products.findPromoById(id, ctx.tenant.business.id);
        if (!promo) return { text: 'Promo no encontrada.', parseMode: 'Markdown' };

        if (conversations) {
          await conversations.upsert({
            businessId: ctx.tenant.business.id,
            userId: ctx.actorUserId,
            phase: 'COLLECTING',
            actionName: 'crear_editar_promo',
            data: { _awaitingPromoDescId: promo.id, promoName: promo.name },
            expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
            updatedAt: ctx.now,
          });
        }
        return {
          text: `📝 Ingresá la nueva descripción para *${esc(promo.name)}* (o enviá \`-\` para quitarla):`,
          parseMode: 'Markdown',
        };
      }

      // 29. Promos: desactivar / pausar
      if (data.startsWith('rotiseria:promo:deactivate:')) {
        const id = data.slice('rotiseria:promo:deactivate:'.length);
        const updated = await products.updatePromo(id, ctx.tenant.business.id, { isActive: false });
        if (audit) {
          await audit.log({
            businessId: ctx.tenant.business.id,
            actorUserId: ctx.actorUserId,
            action: 'promo.deactivated',
            entityType: 'rotiseria_promo',
            entityId: id,
            metadata: { name: updated.name },
          });
        }
        const descText = updated.description ? `_${esc(updated.description)}_` : '_(Sin descripción)_';
        const card = [
          `⏸️ *Promo pausada: ${esc(updated.name)}*`,
          '',
          `💰 Precio: *${formatCurrency(Number(updated.price))}*`,
          `📝 Detalle: ${descText}`,
          `📌 Estado: *⏸️ Pausada*`,
        ].join('\n');
        const buttons: InlineButton[][] = [
          [
            { text: '💵 Cambiar precio', callbackData: `rotiseria:promo:edit_price:${updated.id}` },
            { text: '📝 Cambiar descripción', callbackData: `rotiseria:promo:edit_desc:${updated.id}` },
          ],
          [{ text: '▶️ Reactivar', callbackData: `rotiseria:promo:activate:${updated.id}` }],
          [{ text: '⬅️ Volver a promos', callbackData: 'rotiseria:promo:listar' }],
        ];
        return { text: card, parseMode: 'Markdown', inlineKeyboard: buttons };
      }

      // 30. Promos: reactivar
      if (data.startsWith('rotiseria:promo:activate:')) {
        const id = data.slice('rotiseria:promo:activate:'.length);
        const updated = await products.updatePromo(id, ctx.tenant.business.id, { isActive: true });
        if (audit) {
          await audit.log({
            businessId: ctx.tenant.business.id,
            actorUserId: ctx.actorUserId,
            action: 'promo.activated',
            entityType: 'rotiseria_promo',
            entityId: id,
            metadata: { name: updated.name },
          });
        }
        const descText = updated.description ? `_${esc(updated.description)}_` : '_(Sin descripción)_';
        const card = [
          `🟢 *Promo reactivada: ${esc(updated.name)}*`,
          '',
          `💰 Precio: *${formatCurrency(Number(updated.price))}*`,
          `📝 Detalle: ${descText}`,
          `📌 Estado: *🟢 Activa*`,
        ].join('\n');
        const buttons: InlineButton[][] = [
          [
            { text: '💵 Cambiar precio', callbackData: `rotiseria:promo:edit_price:${updated.id}` },
            { text: '📝 Cambiar descripción', callbackData: `rotiseria:promo:edit_desc:${updated.id}` },
          ],
          [{ text: '🚫 Pausar / Desactivar', callbackData: `rotiseria:promo:deactivate:${updated.id}` }],
          [{ text: '⬅️ Volver a promos', callbackData: 'rotiseria:promo:listar' }],
        ];
        return { text: card, parseMode: 'Markdown', inlineKeyboard: buttons };
      }

      // 31. Promos: listar
      if (data === 'rotiseria:promo:listar') {
        const promoList = await products.listPromos(ctx.tenant.business.id, { includeInactive: true });
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
          text: '🎁 *Gestión de Promociones*\n\nSeleccioná una promo para editar o creá una nueva:',
          parseMode: 'Markdown',
          inlineKeyboard: rows,
        };
      }

      // 32. Promos: cancelar
      if (data === 'rotiseria:promo:cancelar') {
        if (conversations) {
          await conversations.clear(ctx.tenant.business.id, ctx.actorUserId);
        }
        return { text: 'Operación cancelada.', parseMode: 'Markdown' };
      }

      // 33. Historial: 10 ventas
      if (data === 'rotiseria:historial:10') {
        const recent = await sales.listRecentSales(ctx.tenant.business.id, 10);
        const tz = ctx.tenant.business.timezone ?? 'America/Argentina/Buenos_Aires';
        const blocks = recent.map((sale) => {
          const num = formatSaleNumber(sale.id);
          const status = sale.isCancelled ? ' ❌ *[ANULADA]*' : '';
          const items = sale.items.map((it) => `  • ${formatQty(Number(it.quantity))}x ${esc(it.name)}`).join('\n');
          return `🛒 *Venta #${num}* (*${formatCurrency(Number(sale.total))}*) — _${formatRealDateWithDay(sale.shiftDate)}_ (${formatTimeOnly(sale.createdAt, tz)} hs)${status}\n${items}`;
        });
        return {
          text: [`🧾 *Últimas ${recent.length} ventas:*`, '', ...blocks].join('\n'),
          parseMode: 'Markdown',
          inlineKeyboard: [
            [
              { text: '📄 Ver últimas 5 ventas', callbackData: 'rotiseria:historial:5' },
              { text: '❌ Cerrar', callbackData: 'rotiseria:historial:cerrar' },
            ],
          ],
        };
      }

      // 34. Historial: 5 ventas
      if (data === 'rotiseria:historial:5') {
        const recent = await sales.listRecentSales(ctx.tenant.business.id, 5);
        const tz = ctx.tenant.business.timezone ?? 'America/Argentina/Buenos_Aires';
        const blocks = recent.map((sale) => {
          const num = formatSaleNumber(sale.id);
          const status = sale.isCancelled ? ' ❌ *[ANULADA]*' : '';
          const items = sale.items.map((it) => `  • ${formatQty(Number(it.quantity))}x ${esc(it.name)}`).join('\n');
          return `🛒 *Venta #${num}* (*${formatCurrency(Number(sale.total))}*) — _${formatRealDateWithDay(sale.shiftDate)}_ (${formatTimeOnly(sale.createdAt, tz)} hs)${status}\n${items}`;
        });
        return {
          text: [`🧾 *Últimas ${recent.length} ventas:*`, '', ...blocks].join('\n'),
          parseMode: 'Markdown',
          inlineKeyboard: [
            [
              { text: '📄 Ver últimas 10 ventas', callbackData: 'rotiseria:historial:10' },
              { text: '❌ Cerrar', callbackData: 'rotiseria:historial:cerrar' },
            ],
          ],
        };
      }

      // 35. Historial: cerrar
      if (data === 'rotiseria:historial:cerrar' || data === 'rotiseria:cerrar') {
        return { text: 'Operación cerrada.', parseMode: 'Markdown' };
      }

      // 36. Asignar flete a zona no reconocida
      if (data.startsWith('rotiseria:asignar_flete:')) {
        const rawZona = decodeURIComponent(data.replace('rotiseria:asignar_flete:', ''));
        if (conversations && activeState) {
          await conversations.upsert({
            businessId: ctx.tenant.business.id,
            userId: ctx.actorUserId,
            phase: 'COLLECTING',
            actionName: 'registrar_venta',
            data: {
              ...activeState.data,
              zona_envio: rawZona,
              _awaitingManualFee: true,
            },
            expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
            updatedAt: ctx.now,
          });
        }
        return {
          text: `🛵 *Asignar Flete a "${esc(rawZona)}"*\n\nEscribí el monto del envío (ej: *2000*, o *0* si es gratis):`,
          parseMode: 'Markdown',
        };
      }

      // 36b. Asignar precio manual a ítem no catalogado / especial
      if (data.startsWith('rotiseria:precio_item:')) {
        const itemIndex = parseInt(data.replace('rotiseria:precio_item:', ''), 10);
        const currentData = (activeState?.data ?? {}) as Record<string, unknown>;
        const currentItems = Array.isArray(currentData.items) ? currentData.items : [];
        const targetItem = currentItems[itemIndex];
        const itemName = targetItem ? String((targetItem as any).nombre ?? (targetItem as any).name) : 'el ítem';

        if (conversations && activeState) {
          await conversations.upsert({
            businessId: ctx.tenant.business.id,
            userId: ctx.actorUserId,
            phase: 'COLLECTING',
            actionName: 'registrar_venta',
            data: {
              ...activeState.data,
              _awaitingItemPriceIndex: itemIndex,
              _awaitingItemPriceFor: itemName,
            },
            expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
            updatedAt: ctx.now,
          });
        }
        return {
          text: `💵 ¿Qué precio unitario tiene *${esc(itemName)}*? Escribí el monto (ej: *2500*):`,
          parseMode: 'Markdown',
        };
      }

      // 37. Menú de flete interactivo
      if (data === 'rotiseria:flete_menu') {
        const zones = await deliveryZones.listActive(ctx.tenant.business.id);
        const rows: InlineButton[][] = [];

        for (const z of zones) {
          const feeStr = z.price === 0 ? '¡GRATIS! ($0)' : formatCurrency(z.price);
          rows.push([
            {
              text: `🛵 ${z.name} (${feeStr})`,
              callbackData: `rotiseria:flete_set:${z.id}`,
            },
          ]);
        }

        rows.push([
          { text: '✍️ Ingresar monto manual / barrio', callbackData: 'rotiseria:flete_manual' },
          { text: '🚫 Sin envío (Retiro en local)', callbackData: 'rotiseria:flete_quitar' },
        ]);
        rows.push([{ text: '↩️ Volver', callbackData: 'rotiseria:flete_volver' }]);

        return {
          text: '🛵 *Envíos*\n\nElegí una zona de entrega, ingresá el monto manualmente o quitá el envío:',
          parseMode: 'Markdown',
          inlineKeyboard: rows,
        };
      }

      // 38. Flete manual / Modificar envío
      if (data === 'rotiseria:flete_manual' || data === 'rotiseria:envio_modificar') {
        if (conversations && activeState) {
          await conversations.upsert({
            businessId: ctx.tenant.business.id,
            userId: ctx.actorUserId,
            phase: 'COLLECTING',
            actionName: 'registrar_venta',
            data: {
              ...activeState.data,
              _awaitingDelivery: true,
            },
            expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
            updatedAt: ctx.now,
          });
        }
        return {
          text: "Escribí o decime el barrio o el monto del flete (ej: 'Grand Bourg' o '2500'). Para sacarlo, escribí '0' o 'sin envío'.",
          parseMode: 'Markdown',
        };
      }

      // 39. Fijar flete desde zona de catálogo
      if (data.startsWith('rotiseria:flete_set:')) {
        const zoneId = data.replace('rotiseria:flete_set:', '');
        const zones = await deliveryZones.listActive(ctx.tenant.business.id);
        const selected = zones.find((z) => z.id === zoneId);

        if (selected && conversations && activeState) {
          const currentData = (activeState.data ?? {}) as Record<string, unknown>;
          const updatedData: Record<string, unknown> = {
            ...currentData,
            zona_envio: selected.name,
            flete_monto: selected.price,
            zona_no_reconocida: null,
            _awaitingDelivery: false,
            _awaitingManualFee: false,
          };


          const items = Array.isArray(updatedData.items) ? updatedData.items : [];
          let breakdown: string[] | undefined;
          let total: number | undefined;
          let foodTotal: number | undefined;

          try {
            const catalog = await products.getCatalogLookup(ctx.tenant.business.id);
            const pricing = calculatePricing(
              items.map((it: any) => ({ name: it.nombre ?? it.name, quantity: it.cantidad ?? it.quantity })),
              catalog,
              { fee: selected.price, zoneName: selected.name }
            );
            breakdown = pricing.breakdown;
            total = pricing.total;
            foodTotal = pricing.foodTotal;
          } catch {
            // fallback
          }

          await conversations.upsert({
            businessId: ctx.tenant.business.id,
            userId: ctx.actorUserId,
            phase: 'CONFIRMING',
            actionName: 'registrar_venta',
            data: updatedData,
            expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
            updatedAt: ctx.now,
          });

          const summary = formatSaleSummary({
            items: items.map((it: any) => ({ nombre: it.nombre ?? it.name, cantidad: it.cantidad ?? it.quantity })),
            nota: updatedData.nota as string | undefined,
            fecha: updatedData.fecha as string | undefined,
            breakdown,
            total,
            foodTotal,
            deliveryFee: selected.price,
            deliveryZoneName: selected.name,
            now: ctx.now,
            timezone: ctx.tenant.business.timezone,
          });

          return {
            text: summary,
            parseMode: 'Markdown',
            inlineKeyboard: [
              [
                { text: '✅ Confirmar venta', callbackData: 'confirm:yes' },
                { text: '❌ Cancelar', callbackData: 'confirm:no' },
              ],
              [
                { text: '🛵 Envíos', callbackData: 'rotiseria:flete_menu' },
                { text: '✏️ Modificar pedido', callbackData: 'rotiseria:modificar' },
              ],
              [{ text: '📅 Cambiar fecha', callbackData: 'rotiseria:fecha' }],
            ],
          };
        }
      }

      // 40. Quitar flete (Retiro en mostrador)
      if (data === 'rotiseria:flete_quitar') {
        if (conversations && activeState) {
          const currentData = (activeState.data ?? {}) as Record<string, unknown>;
          const updatedData: Record<string, unknown> = {
            ...currentData,
            zona_envio: null,
            flete_monto: null,
            zona_no_reconocida: null,
            _awaitingDelivery: false,
            _awaitingManualFee: false,
          };


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
            // fallback
          }

          await conversations.upsert({
            businessId: ctx.tenant.business.id,
            userId: ctx.actorUserId,
            phase: 'CONFIRMING',
            actionName: 'registrar_venta',
            data: updatedData,
            expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
            updatedAt: ctx.now,
          });

          const summary = formatSaleSummary({
            items: items.map((it: any) => ({ nombre: it.nombre ?? it.name, cantidad: it.cantidad ?? it.quantity })),
            nota: updatedData.nota as string | undefined,
            fecha: updatedData.fecha as string | undefined,
            breakdown,
            total,
            now: ctx.now,
            timezone: ctx.tenant.business.timezone,
          });

          return {
            text: summary,
            parseMode: 'Markdown',
            inlineKeyboard: [
              [
                { text: '✅ Confirmar venta', callbackData: 'confirm:yes' },
                { text: '❌ Cancelar', callbackData: 'confirm:no' },
              ],
              [
                { text: '🛵 Envíos', callbackData: 'rotiseria:flete_menu' },
                { text: '✏️ Modificar pedido', callbackData: 'rotiseria:modificar' },
              ],
              [{ text: '📅 Cambiar fecha', callbackData: 'rotiseria:fecha' }],
            ],
          };
        }
      }

      // 41. Volver al resumen desde menú de flete
      if (data === 'rotiseria:flete_volver') {
        if (activeState) {
          const currentData = (activeState.data ?? {}) as Record<string, unknown>;
          const items = Array.isArray(currentData.items) ? currentData.items : [];
          let breakdown: string[] | undefined;
          let total: number | undefined;
          let foodTotal: number | undefined;
          let deliveryFee: number | null | undefined = currentData.flete_monto as number | undefined;
          let deliveryZoneName: string | null | undefined = currentData.zona_envio as string | undefined;

          try {
            const catalog = await products.getCatalogLookup(ctx.tenant.business.id);
            const pricing = calculatePricing(
              items.map((it: any) => ({ name: it.nombre ?? it.name, quantity: it.cantidad ?? it.quantity })),
              catalog,
              deliveryFee !== undefined ? { fee: deliveryFee, zoneName: deliveryZoneName } : undefined
            );
            breakdown = pricing.breakdown;
            total = pricing.total;
            foodTotal = pricing.foodTotal;
            deliveryFee = pricing.deliveryFee;
            deliveryZoneName = pricing.deliveryZoneName;
          } catch {
            // fallback
          }

          const summary = formatSaleSummary({
            items: items.map((it: any) => ({ nombre: it.nombre ?? it.name, cantidad: it.cantidad ?? it.quantity })),
            nota: currentData.nota as string | undefined,
            fecha: currentData.fecha as string | undefined,
            breakdown,
            total,
            foodTotal,
            deliveryFee,
            deliveryZoneName,
            now: ctx.now,
            timezone: ctx.tenant.business.timezone,
          });

          return {
            text: summary,
            parseMode: 'Markdown',
            inlineKeyboard: [
              [
                { text: '✅ Confirmar venta', callbackData: 'confirm:yes' },
                { text: '❌ Cancelar', callbackData: 'confirm:no' },
              ],
              [
                { text: '🛵 Envíos', callbackData: 'rotiseria:flete_menu' },
                { text: '✏️ Modificar pedido', callbackData: 'rotiseria:modificar' },
              ],
              [{ text: '📅 Cambiar fecha', callbackData: 'rotiseria:fecha' }],
            ],
          };
        }
      }

      // 42. Prompt para cargar zonas en lote / Guía rápida
      if (data === 'rotiseria:envios_lote_prompt' || data === 'rotiseria:envios_lote_guia') {
        if (conversations) {
          await conversations.upsert({
            businessId: ctx.tenant.business.id,
            userId: ctx.actorUserId,
            phase: 'COLLECTING',
            actionName: 'configurar_envios_lote',
            data: {},
            expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
            updatedAt: ctx.now,
          });
        }
        return {
          text: [
            '🎙️ *Carga rápida de zonas por voz o texto*',
            '',
            'Podés mandarme un solo audio o escribir un mensaje agrupando los barrios por precio, por ejemplo:',
            '',
            '👉 _"Centro y Macrocentro a 1500; Grand Bourg, San Carlos y Tribuno a 2500; San Lorenzo a 4000; Microcentro gratis"_',
            '',
            'Mandá tu audio o mensaje ahora:',
          ].join('\n'),
          parseMode: 'Markdown',
        };
      }

      // 43. Cambiar precio de una zona: desplegar zonas activas
      if (data === 'rotiseria:envios_cambiar_precio') {
        const zones = await deliveryZones.listActive(ctx.tenant.business.id);
        if (zones.length === 0) {
          return {
            text: 'Todavía no tenés zonas de envío configuradas para modificar.',
            parseMode: 'Markdown',
            inlineKeyboard: [[{ text: '↩️ Volver a Envíos', callbackData: 'rotiseria:envios_menu' }]],
          };
        }
        const rows: InlineButton[][] = [];
        for (const z of zones) {
          const feeStr = z.price === 0 ? '¡GRATIS! ($0)' : formatCurrency(z.price);
          rows.push([
            {
              text: `🏷️ ${z.name} (${feeStr})`,
              callbackData: `rotiseria:envio_sel:${z.id}`,
            },
          ]);
        }
        rows.push([{ text: '↩️ Volver a Envíos', callbackData: 'rotiseria:envios_menu' }]);

        return {
          text: '🛵 *Seleccioná la zona a la que querés cambiarle el precio:*',
          parseMode: 'Markdown',
          inlineKeyboard: rows,
        };
      }

      // 44. Zona seleccionada para cambiar precio: preguntar nuevo precio
      if (data.startsWith('rotiseria:envio_sel:')) {
        const zoneId = data.slice('rotiseria:envio_sel:'.length);
        const zones = await deliveryZones.listActive(ctx.tenant.business.id);
        const selected = zones.find((z) => z.id === zoneId);
        if (!selected) {
          return { text: 'Zona no encontrada o inactiva.', parseMode: 'Markdown' };
        }

        if (conversations) {
          await conversations.upsert({
            businessId: ctx.tenant.business.id,
            userId: ctx.actorUserId,
            phase: 'COLLECTING',
            actionName: 'gestionar_envios',
            data: {
              _awaitingZonePriceId: selected.id,
              zoneName: selected.name,
              currentPrice: selected.price,
            },
            expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
            updatedAt: ctx.now,
          });
        }

        return {
          text: `¿Qué nuevo precio tiene *${esc(selected.name)}*? (Escribí el monto o 0 para gratis):`,
          parseMode: 'Markdown',
        };
      }

      // 45. Estadísticas de fletes y zonas
      if (data === 'rotiseria:envios_stats') {
        const tz = ctx.tenant.business.timezone ?? 'America/Argentina/Buenos_Aires';
        const currentShift = getShiftDate(ctx.now, tz);
        const sinceDate = new Date(currentShift);
        sinceDate.setUTCDate(sinceDate.getUTCDate() - 30);

        const deliveryStats = await sales.getDeliveryStats(ctx.tenant.business.id, sinceDate);
        const statsText = formatDeliveryStatsSummary(deliveryStats);

        return {
          text: statsText,
          parseMode: 'Markdown',
          inlineKeyboard: [[{ text: '↩️ Volver a Envíos', callbackData: 'rotiseria:envios_menu' }]],
        };
      }

      // 46. Volver al panel principal de envíos
      if (data === 'rotiseria:envios_menu') {
        if (conversations) {
          await conversations.clear(ctx.tenant.business.id, ctx.actorUserId);
        }
        const zones = await deliveryZones.listActive(ctx.tenant.business.id);
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
          text: lines.join('\n'),
          parseMode: 'Markdown',
          inlineKeyboard: [
            [{ text: '➕ Cargar por lote (audio/texto)', callbackData: 'rotiseria:envios_lote_guia' }],
            [{ text: '🏷️ Cambiar precio de una zona', callbackData: 'rotiseria:envios_cambiar_precio' }],
            [{ text: '🗑️ Eliminar zona', callbackData: 'rotiseria:zonas_listar_borrar' }],
            [{ text: '📊 Zonas con más movimiento', callbackData: 'rotiseria:envios_stats' }],
          ],
        };
      }

      // 47. Quitar ítem del pedido en borrador (CONFIRMING o COLLECTING)
      if (data.startsWith('rotiseria:quitar_linea:')) {
        const itemIdx = parseInt(data.slice('rotiseria:quitar_linea:'.length), 10);
        const currentData = (activeState?.data ?? {}) as Record<string, unknown>;
        const currentItems: Array<{ nombre: string; cantidad: number; precio_unitario?: number }> = Array.isArray(currentData.items)
          ? currentData.items.map((it: any) => ({
              nombre: String(it.nombre ?? it.name),
              cantidad: Number(it.cantidad ?? it.quantity),
              precio_unitario: it.precio_unitario !== undefined && it.precio_unitario !== null ? Number(it.precio_unitario) : undefined,
            }))
          : [];

        if (itemIdx >= 0 && itemIdx < currentItems.length) {
          currentItems.splice(itemIdx, 1);
        }

        if (currentItems.length === 0) {
          if (conversations) {
            await conversations.clear(ctx.tenant.business.id, ctx.actorUserId);
          }
          return {
            text: '❌ Pedido cancelado al haberse quitado todos los productos.',
            parseMode: 'Markdown',
          };
        }

        let breakdown: string[] | undefined;
        let total: number | undefined;
        let foodTotal: number | undefined;
        let deliveryFee: number | null | undefined = currentData.flete_monto as number | undefined;
        let deliveryZoneName: string | null | undefined = currentData.zona_envio as string | undefined;

        try {
          const catalog = await products.getCatalogLookup(ctx.tenant.business.id);
          const pricing = calculatePricing(
            currentItems.map((it) => ({ name: it.nombre, quantity: it.cantidad, unitPrice: it.precio_unitario })),
            catalog,
            deliveryFee !== undefined && deliveryFee !== null ? { fee: deliveryFee, zoneName: deliveryZoneName } : undefined
          );
          breakdown = pricing.breakdown;
          total = pricing.total;
          foodTotal = pricing.foodTotal;
          deliveryFee = pricing.deliveryFee;
          deliveryZoneName = pricing.deliveryZoneName;
        } catch {
          // fallback
        }

        const updatedData: Record<string, unknown> = {
          ...currentData,
          items: currentItems,
          _modifying: true,
          _awaitingModification: false,
          _uncataloguedZeroItems: undefined,
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

        const summaryText = formatSaleSummary({
          items: currentItems,
          nota: updatedData.nota as string | undefined,
          fecha: updatedData.fecha as string | undefined,
          breakdown,
          total,
          foodTotal,
          deliveryFee,
          deliveryZoneName,
          zonaNoReconocida: updatedData.zona_no_reconocida as string | undefined,
          isModifying: true,
          now: ctx.now,
          timezone: ctx.tenant.business.timezone,
        });

        const actionReg = template.actions.find((a) => a.name === 'registrar_venta');
        const keyboard = actionReg?.confirmButtons ? actionReg.confirmButtons(updatedData) : undefined;

        return {
          text: summaryText,
          parseMode: 'Markdown',
          inlineKeyboard: keyboard,
        };
      }

      // 48. Eliminar / Desactivar zona de envío (Listado de zonas a borrar)
      if (data === 'rotiseria:zonas_listar_borrar') {
        if (ctx.tenant.membership.role !== 'OWNER') {
          return {
            text: '⛔ Solo el dueño del negocio puede desactivar zonas de envío.',
            parseMode: 'Markdown',
          };
        }
        const zones = await deliveryZones.listActive(ctx.tenant.business.id);
        if (zones.length === 0) {
          return {
            text: 'No hay zonas de envío activas para eliminar.',
            parseMode: 'Markdown',
            inlineKeyboard: [[{ text: '↩️ Volver a Envíos', callbackData: 'rotiseria:envios_menu' }]],
          };
        }
        const rows: InlineButton[][] = [];
        for (const z of zones) {
          rows.push([
            {
              text: `❌ Borrar ${z.name.slice(0, 24)}`,
              callbackData: `rotiseria:zona_deactivate:${z.id}`,
            },
          ]);
        }
        rows.push([{ text: '↩️ Volver a Envíos', callbackData: 'rotiseria:envios_menu' }]);

        return {
          text: '🗑️ *Seleccioná la zona que querés eliminar:*',
          parseMode: 'Markdown',
          inlineKeyboard: rows,
        };
      }

      // 49. Confirmar desactivación de zona
      if (data.startsWith('rotiseria:zona_deactivate:')) {
        if (ctx.tenant.membership.role !== 'OWNER') {
          return {
            text: '⛔ Solo el dueño del negocio puede desactivar zonas de envío.',
            parseMode: 'Markdown',
          };
        }
        const zoneId = data.slice('rotiseria:zona_deactivate:'.length);
        const deactivated = await deliveryZones.deactivate(zoneId, ctx.tenant.business.id);
        if (audit) {
          await audit.log({
            businessId: ctx.tenant.business.id,
            actorUserId: ctx.actorUserId,
            action: 'delivery_zone.deactivated',
            entityType: 'rotiseria_delivery_zone',
            entityId: deactivated.id,
            metadata: { name: deactivated.name },
          });
        }
        return {
          text: `✅ Zona '${esc(deactivated.name)}' eliminada correctamente.`,
          parseMode: 'Markdown',
          inlineKeyboard: [[{ text: '↩️ Volver a Envíos', callbackData: 'rotiseria:envios_menu' }]],
        };
      }

      // 50. Menú principal de Bebidas
      if (data === 'rotiseria:bebidas_menu') {
        if (conversations) {
          await conversations.clear(ctx.tenant.business.id, ctx.actorUserId);
        }
        const drinks = await products.listProducts(ctx.tenant.business.id, { category: 'bebidas', limit: 100 });
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
          text: lines.join('\n'),
          parseMode: 'Markdown',
          inlineKeyboard: [
            [{ text: '➕ Cargar bebidas por lote', callbackData: 'rotiseria:bebidas_lote' }],
            [{ text: '💵 Modificar precio', callbackData: 'rotiseria:bebidas_precio' }],
            [{ text: '🗑️ Eliminar / Desactivar bebida', callbackData: 'rotiseria:bebidas_borrar' }],
          ],
        };
      }

      // 51. Guía de carga de bebidas por lote
      if (data === 'rotiseria:bebidas_lote') {
        if (conversations) {
          await conversations.upsert({
            businessId: ctx.tenant.business.id,
            userId: ctx.actorUserId,
            phase: 'COLLECTING',
            actionName: 'configurar_bebidas_lote',
            data: { _awaitingBebidasLote: true },
            expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
            updatedAt: ctx.now,
          });
        }
        return {
          text: [
            '🥤 *Carga de Bebidas por Lote*',
            '',
            'Escribí o mandá un audio con tus bebidas y precios:',
            '👉 *"Coca 1.5L 3500, Sprite 1.5L 3500, Cerveza Quilmes 1L 4000, Agua 500ml 1500"*',
            '',
            'También podés ponerlas renglón por renglón.',
          ].join('\n'),
          parseMode: 'Markdown',
        };
      }

      // 52. Selector de bebida para cambiar precio
      if (data === 'rotiseria:bebidas_precio') {
        const drinks = await products.listProducts(ctx.tenant.business.id, { category: 'bebidas', limit: 100 });
        if (drinks.length === 0) {
          return {
            text: 'No hay bebidas cargadas para modificar precios.',
            parseMode: 'Markdown',
            inlineKeyboard: [[{ text: '↩️ Volver a Bebidas', callbackData: 'rotiseria:bebidas_menu' }]],
          };
        }
        const rows: InlineButton[][] = [];
        for (const d of drinks) {
          rows.push([
            {
              text: `💵 ${d.name} (${formatCurrency(Number(d.priceUnit))})`,
              callbackData: `rotiseria:bebida_sel:${d.id}`,
            },
          ]);
        }
        rows.push([{ text: '↩️ Volver a Bebidas', callbackData: 'rotiseria:bebidas_menu' }]);

        return {
          text: '🥤 *Seleccioná la bebida a la que querés cambiarle el precio:*',
          parseMode: 'Markdown',
          inlineKeyboard: rows,
        };
      }

      // 53. Bebida seleccionada: pedir nuevo precio
      if (data.startsWith('rotiseria:bebida_sel:')) {
        const prodId = data.slice('rotiseria:bebida_sel:'.length);
        const prod = await products.findProductById(prodId, ctx.tenant.business.id);
        if (!prod) {
          return { text: 'Bebida no encontrada o inactiva.', parseMode: 'Markdown' };
        }

        if (conversations) {
          await conversations.upsert({
            businessId: ctx.tenant.business.id,
            userId: ctx.actorUserId,
            phase: 'COLLECTING',
            actionName: 'gestionar_bebidas',
            data: {
              _awaitingDrinkPriceId: prod.id,
              productName: prod.name,
              currentPrice: Number(prod.priceUnit),
            },
            expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
            updatedAt: ctx.now,
          });
        }

        return {
          text: `Ingresá el nuevo precio unitario para *${esc(prod.name)}* (Precio actual: *${formatCurrency(Number(prod.priceUnit))}*):`,
          parseMode: 'Markdown',
        };
      }

      // 54. Listar bebidas para eliminar / desactivar
      if (data === 'rotiseria:bebidas_borrar') {
        if (ctx.tenant.membership.role !== 'OWNER') {
          return {
            text: '⛔ Solo el dueño del negocio puede eliminar o desactivar bebidas.',
            parseMode: 'Markdown',
          };
        }
        const drinks = await products.listProducts(ctx.tenant.business.id, { category: 'bebidas', limit: 100 });
        if (drinks.length === 0) {
          return {
            text: 'No hay bebidas activas para eliminar.',
            parseMode: 'Markdown',
            inlineKeyboard: [[{ text: '↩️ Volver a Bebidas', callbackData: 'rotiseria:bebidas_menu' }]],
          };
        }
        const rows: InlineButton[][] = [];
        for (const d of drinks) {
          rows.push([
            {
              text: `❌ Borrar ${d.name.slice(0, 24)}`,
              callbackData: `rotiseria:bebida_deactivate:${d.id}`,
            },
          ]);
        }
        rows.push([{ text: '↩️ Volver a Bebidas', callbackData: 'rotiseria:bebidas_menu' }]);

        return {
          text: '🗑️ *Seleccioná la bebida que querés eliminar:*',
          parseMode: 'Markdown',
          inlineKeyboard: rows,
        };
      }

      // 55. Confirmar desactivación de bebida
      if (data.startsWith('rotiseria:bebida_deactivate:')) {
        if (ctx.tenant.membership.role !== 'OWNER') {
          return {
            text: '⛔ Solo el dueño del negocio puede eliminar o desactivar bebidas.',
            parseMode: 'Markdown',
          };
        }
        const prodId = data.slice('rotiseria:bebida_deactivate:'.length);
        const deactivated = await products.deactivateProduct(prodId, ctx.tenant.business.id);
        if (audit) {
          await audit.log({
            businessId: ctx.tenant.business.id,
            actorUserId: ctx.actorUserId,
            action: 'drink.deactivated',
            entityType: 'rotiseria_product',
            entityId: deactivated.id,
            metadata: { name: deactivated.name },
          });
        }
        return {
          text: `✅ Bebida '${esc(deactivated.name)}' eliminada correctamente.`,
          parseMode: 'Markdown',
          inlineKeyboard: [[{ text: '↩️ Volver a Bebidas', callbackData: 'rotiseria:bebidas_menu' }]],
        };
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
