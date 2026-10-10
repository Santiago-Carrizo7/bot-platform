import { AppError } from '../../../core/errors/errors.js';
import type { RotiseriaProduct, RotiseriaPromo } from '@prisma/client';
import type { PricingResult, ResolvedSaleLine, SaleLineInput } from '../types.js';
import { esc, formatCurrency, formatQty, round2 } from '../format.js';

export { round2 };

export interface CatalogLookup {
  findProduct: (name: string) => RotiseriaProduct | undefined;
  findPromo: (name: string) => RotiseriaPromo | undefined;
}

export interface DeliveryPricingInput {
  fee?: number | null;
  zoneName?: string | null;
}

const DELIVERY_KEYWORDS = ['envio', 'envio gratis', 'flete', 'cadete', 'cadeteria', 'delivery'];

function isDeliveryItemName(name: string): boolean {
  const norm = name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return DELIVERY_KEYWORDS.includes(norm);
}

/**
 * Calcula el importe de una venta de rotisería con:
 * - Promociones fijas (categoría 'promos')
 * - Productos normales a precio unitario
 * - Agrupación automática de docenas separadas por tarifa (priceDozen),
 *   liquidando remanentes (< 12) a precio unitario individual.
 * - Desglose opcional de flete/delivery ($0 / gratis o con cargo).
 */
export function calculatePricing(
  items: SaleLineInput[],
  catalog: CatalogLookup,
  delivery?: DeliveryPricingInput
): PricingResult {
  if (items.length === 0) {
    throw new AppError('La venta necesita al menos un producto o promo');
  }

  const specialLines: SaleLineInput[] = [];
  const promoLines: Array<{ promo: RotiseriaPromo; quantity: number }> = [];
  const regularLines: Array<{ product: RotiseriaProduct; quantity: number }> = [];
  const dozenEligibleLines: Array<{ product: RotiseriaProduct; quantity: number }> = [];

  for (const item of items) {
    if (item.quantity <= 0) {
      throw new AppError(`La cantidad para "${item.name}" debe ser mayor a 0`);
    }

    if (isDeliveryItemName(item.name)) {
      throw new AppError(
        `"${item.name}" es un concepto de envío o flete y no puede registrarse como comida en el menú.`
      );
    }

    // 1. Verificar si coincide con una promo activa
    const promo = catalog.findPromo(item.name);
    if (promo) {
      promoLines.push({ promo, quantity: item.quantity });
      continue;
    }

    // 2. Verificar si coincide con un producto activo
    const product = catalog.findProduct(item.name);
    if (product) {
      if (product.priceDozen !== null && Number(product.priceDozen) > 0) {
        dozenEligibleLines.push({ product, quantity: item.quantity });
      } else {
        regularLines.push({ product, quantity: item.quantity });
      }
      continue;
    }

    // 3. Ítem no catalogado / especial (NUNCA bloquear la comanda)
    specialLines.push(item);
  }

  const resultLines: ResolvedSaleLine[] = [];
  const breakdown: string[] = [];
  let total = 0;

  // A. Procesar Promos
  for (const { promo, quantity } of promoLines) {
    const price = Number(promo.price);
    const subtotal = round2(price * quantity);
    total = round2(total + subtotal);

    resultLines.push({
      productId: null,
      promoId: promo.id,
      name: promo.name,
      category: 'promos',
      quantity,
      unitPrice: price,
      subtotal,
    });

    breakdown.push(`• ${formatQty(quantity)}x Promo *${esc(promo.name)}* — *${formatCurrency(subtotal)}*`);
  }

  // B. Procesar Productos regulares (sin docena)
  for (const { product, quantity } of regularLines) {
    const price = Number(product.priceUnit);
    const subtotal = round2(price * quantity);
    total = round2(total + subtotal);

    resultLines.push({
      productId: product.id,
      promoId: null,
      name: product.name,
      category: product.category || 'general',
      quantity,
      unitPrice: price,
      subtotal,
    });

    breakdown.push(`• ${formatQty(quantity)}x *${esc(product.name)}* — *${formatCurrency(subtotal)}*`);
  }

  // C. Procesar Productos con docena agrupados por tarifa (priceDozen)
  if (dozenEligibleLines.length > 0) {
    const tierMap = new Map<number, Array<{ product: RotiseriaProduct; quantity: number }>>();
    for (const line of dozenEligibleLines) {
      const tier = Number(line.product.priceDozen);
      const existing = tierMap.get(tier) ?? [];
      existing.push(line);
      tierMap.set(tier, existing);
    }

    for (const [priceDozen, tierLines] of tierMap.entries()) {
      const totalDozenUnits = tierLines.reduce((acc, curr) => acc + curr.quantity, 0);
      const fullDozens = Math.floor(totalDozenUnits / 12);
      const remainderUnits = totalDozenUnits % 12;

      if (fullDozens === 0) {
        // No alcanza para una docena en esta tarifa: se cobran a precio unitario
        for (const { product, quantity } of tierLines) {
          const price = Number(product.priceUnit);
          const subtotal = round2(price * quantity);
          total = round2(total + subtotal);

          resultLines.push({
            productId: product.id,
            promoId: null,
            name: product.name,
            category: product.category || 'empanadas',
            quantity,
            unitPrice: price,
            subtotal,
          });

          breakdown.push(`• ${formatQty(quantity)}x *${esc(product.name)}* — *${formatCurrency(subtotal)}*`);
        }
      } else {
        // Hay al menos 1 docena en esta tarifa
        const unitPool: Array<{ product: RotiseriaProduct }> = [];
        for (const line of tierLines) {
          for (let i = 0; i < line.quantity; i++) {
            unitPool.push({ product: line.product });
          }
        }

        // Ordenar por precio unitario ascendente: el remanente toma las unidades más baratas
        unitPool.sort((a, b) => Number(a.product.priceUnit) - Number(b.product.priceUnit));

        const remainderUnitsList = unitPool.slice(0, remainderUnits);
        const dozenUnitsList = unitPool.slice(remainderUnits);

        const dozenSubtotal = round2(fullDozens * priceDozen);
        total = round2(total + dozenSubtotal);

        const dozenBreakdownCounts: Record<string, number> = {};
        for (const item of dozenUnitsList) {
          dozenBreakdownCounts[item.product.name] = (dozenBreakdownCounts[item.product.name] ?? 0) + 1;
        }

        const dozenFlavors = Object.entries(dozenBreakdownCounts)
          .map(([name, qty]) => `${qty} ${name}`)
          .join(', ');
        breakdown.push(
          `• ${fullDozens}x Docena${fullDozens > 1 ? 's' : ''} (${esc(dozenFlavors)}) — *${formatCurrency(dozenSubtotal)}*`
        );

        // Remanente
        const remainderCounts: Record<string, { product: RotiseriaProduct; count: number }> = {};
        for (const item of remainderUnitsList) {
          if (!remainderCounts[item.product.name]) {
            remainderCounts[item.product.name] = { product: item.product, count: 0 };
          }
          remainderCounts[item.product.name].count++;
        }

        for (const { product, count } of Object.values(remainderCounts)) {
          const unitPrice = Number(product.priceUnit);
          const remSubtotal = round2(unitPrice * count);
          total = round2(total + remSubtotal);

          breakdown.push(
            `• ${count}x *${esc(product.name)}* (suelta${count > 1 ? 's' : ''}) — *${formatCurrency(remSubtotal)}*`
          );
        }

        // Generar líneas de venta para persistencia
        for (const line of tierLines) {
          const product = line.product;
          const inRemainder = remainderCounts[product.name]?.count ?? 0;
          const inDozen = dozenBreakdownCounts[product.name] ?? 0;

          const effectiveSubtotal = round2(
            inRemainder * Number(product.priceUnit) +
              inDozen * (priceDozen / 12)
          );

          const effectiveUnitPrice = round2(effectiveSubtotal / line.quantity);

          resultLines.push({
            productId: product.id,
            promoId: null,
            name: product.name,
            category: product.category || 'empanadas',
            quantity: line.quantity,
            unitPrice: effectiveUnitPrice,
            subtotal: effectiveSubtotal,
          });
        }
      }
    }
  }

  // D. Procesar Ítems Especiales / No catalogados
  const uncataloguedItems: Array<{ name: string; quantity: number; unitPrice?: number }> = [];
  for (const item of specialLines) {
    const unitPrice = round2(item.unitPrice ?? 0);
    const subtotal = round2(unitPrice * item.quantity);
    total = round2(total + subtotal);

    resultLines.push({
      productId: null,
      promoId: null,
      name: item.name.trim(),
      category: 'especial',
      quantity: item.quantity,
      unitPrice,
      subtotal,
    });

    uncataloguedItems.push({
      name: item.name.trim(),
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    });

    if (unitPrice === 0) {
      breakdown.push(
        `• ${formatQty(item.quantity)}x *${esc(item.name.trim())}* — $0 (⚠️ Ítem especial / sin precio en carta)`
      );
    } else {
      breakdown.push(
        `• ${formatQty(item.quantity)}x *${esc(item.name.trim())}* — *${formatCurrency(subtotal)}* (Ítem especial)`
      );
    }
  }

  const foodTotal = round2(total);
  let deliveryFee: number | null = null;
  let deliveryZoneName: string | null = null;

  if (delivery && delivery.fee !== undefined && delivery.fee !== null) {
    deliveryFee = round2(Number(delivery.fee));
    deliveryZoneName = delivery.zoneName?.trim() || 'Zona';

    if (deliveryFee === 0) {
      breakdown.push(`• 🛵 Envío (${esc(deliveryZoneName)}): ¡GRATIS! ($0)`);
    } else {
      breakdown.push(`• 🛵 Envío (${esc(deliveryZoneName)}): *${formatCurrency(deliveryFee)}*`);
    }

    total = round2(foodTotal + deliveryFee);
  }

  return {
    lines: resultLines,
    foodTotal,
    deliveryFee,
    deliveryZoneName,
    total: round2(total),
    breakdown,
    uncataloguedItems: uncataloguedItems.length > 0 ? uncataloguedItems : undefined,
  };
}

