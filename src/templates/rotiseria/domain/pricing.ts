import { AppError } from '../../../core/errors/errors.js';
import type { RotiseriaProduct, RotiseriaPromo } from '@prisma/client';
import type { PricingResult, ResolvedSaleLine, SaleLineInput } from '../types.js';
import { esc, formatCurrency, formatQty } from '../format.js';

export interface CatalogLookup {
  findProduct: (name: string) => RotiseriaProduct | undefined;
  findPromo: (name: string) => RotiseriaPromo | undefined;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Calcula el importe de una venta de rotisería con:
 * - Promociones fijas
 * - Productos normales a precio unitario
 * - Agrupación automática de docenas para productos con priceDozen (empanadas),
 *   sean de una misma variedad o combinadas, liquidando remanentes (< 12) a precio unitario.
 */
export function calculatePricing(
  items: SaleLineInput[],
  catalog: CatalogLookup
): PricingResult {
  if (items.length === 0) {
    throw new AppError('La venta necesita al menos un producto o promo');
  }

  const missing: string[] = [];
  const promoLines: Array<{ promo: RotiseriaPromo; quantity: number }> = [];
  const regularLines: Array<{ product: RotiseriaProduct; quantity: number }> = [];
  const dozenEligibleLines: Array<{ product: RotiseriaProduct; quantity: number }> = [];

  for (const item of items) {
    if (item.quantity <= 0) {
      throw new AppError(`La cantidad para "${item.name}" debe ser mayor a 0`);
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

    missing.push(item.name.trim());
  }

  if (missing.length > 0) {
    throw new AppError(
      `No encontré estos productos/promos: ${missing.map((m) => `"${m}"`).join(', ')}. Revisá el catálogo con los botones de abajo.`
    );
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
      quantity,
      unitPrice: price,
      subtotal,
    });

    breakdown.push(`• ${formatQty(quantity)}x *${esc(product.name)}* — *${formatCurrency(subtotal)}*`);
  }

  // C. Procesar Productos con docena (Empanadas individuales o combinadas)
  if (dozenEligibleLines.length > 0) {
    const totalDozenUnits = dozenEligibleLines.reduce((acc, curr) => acc + curr.quantity, 0);
    const fullDozens = Math.floor(totalDozenUnits / 12);
    const remainderUnits = totalDozenUnits % 12;

    if (fullDozens === 0) {
      // No alcanza para una docena: se cobran todas a precio unitario
      for (const { product, quantity } of dozenEligibleLines) {
        const price = Number(product.priceUnit);
        const subtotal = round2(price * quantity);
        total = round2(total + subtotal);

        resultLines.push({
          productId: product.id,
          promoId: null,
          name: product.name,
          quantity,
          unitPrice: price,
          subtotal,
        });

        breakdown.push(`• ${formatQty(quantity)}x *${esc(product.name)}* — *${formatCurrency(subtotal)}*`);
      }
    } else {
      // Hay al menos 1 docena (12 unidades)
      // Expandimos las unidades para prorratear de manera justa las docenas y el remanente
      // Remanente toma las unidades de menor precio unitario en caso de haber precios dispares
      const unitPool: Array<{ product: RotiseriaProduct }> = [];
      for (const line of dozenEligibleLines) {
        for (let i = 0; i < line.quantity; i++) {
          unitPool.push({ product: line.product });
        }
      }

      // Ordenar por precio unitario ascendente: el remanente se cobrará a su precio unitario
      unitPool.sort((a, b) => Number(a.product.priceUnit) - Number(b.product.priceUnit));

      // Las primeras `remainderUnits` son remanente
      const remainderUnitsList = unitPool.slice(0, remainderUnits);
      // Las restantes `fullDozens * 12` unidades forman docenas completas
      const dozenUnitsList = unitPool.slice(remainderUnits);

      // Calcular docenas:
      // Agrupamos en bloques de 12
      let dozenSubtotal = 0;
      const dozenBreakdownCounts: Record<string, number> = {};

      for (let d = 0; d < fullDozens; d++) {
        const group = dozenUnitsList.slice(d * 12, (d + 1) * 12);
        // Precio de la docena: si todas comparten priceDozen, se usa ese; si difieren, la media de priceDozen/12 * 12
        const groupDozenPrice = round2(
          group.reduce((acc, item) => acc + Number(item.product.priceDozen!) / 12, 0)
        );
        dozenSubtotal = round2(dozenSubtotal + groupDozenPrice);

        for (const item of group) {
          dozenBreakdownCounts[item.product.name] = (dozenBreakdownCounts[item.product.name] ?? 0) + 1;
        }
      }

      total = round2(total + dozenSubtotal);

      // Desglose de docenas
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

      // Generar líneas de venta efectivas para persistencia
      // Para cada producto involucrado, prorrateamos su subtotal proporcional exacto
      for (const line of dozenEligibleLines) {
        const product = line.product;
        const inRemainder = remainderCounts[product.name]?.count ?? 0;
        const inDozen = dozenBreakdownCounts[product.name] ?? 0;

        const effectiveSubtotal = round2(
          inRemainder * Number(product.priceUnit) +
            inDozen * (Number(product.priceDozen!) / 12)
        );

        const effectiveUnitPrice = round2(effectiveSubtotal / line.quantity);

        resultLines.push({
          productId: product.id,
          promoId: null,
          name: product.name,
          quantity: line.quantity,
          unitPrice: effectiveUnitPrice,
          subtotal: effectiveSubtotal,
        });
      }
    }
  }

  return {
    lines: resultLines,
    total: round2(total),
    breakdown,
  };
}
