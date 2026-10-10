import type { SaleLineInput } from '../types.js';

export interface OrderPatch {
  add?: SaleLineInput[];
  remove?: string[];
  reduce?: Array<{ name: string; quantity: number }>;
  setQuantity?: Array<{ name: string; quantity: number }>;
  replace?: SaleLineInput[];
}

/**
 * Aplica modificaciones incrementales a una lista de ítems de venta.
 * Soporta reemplazo, adición/suma, reducción numérica, fijación de cantidad y eliminación por nombre.
 */
export function applyModification(
  currentItems: SaleLineInput[],
  patch: OrderPatch
): SaleLineInput[] {
  if (patch.replace && patch.replace.length > 0) {
    return patch.replace.map((it) => ({ ...it }));
  }

  let items = currentItems.map((it) => ({ ...it }));

  // 1. Remove total
  if (patch.remove && patch.remove.length > 0) {
    const toRemove = patch.remove.map((r) => r.toLowerCase().trim()).filter(Boolean);
    items = items.filter(
      (it) => !toRemove.some((r) => it.name.toLowerCase().includes(r) || r.includes(it.name.toLowerCase()))
    );
  }

  // 2. Reduce (restar cantidad)
  if (patch.reduce && patch.reduce.length > 0) {
    for (const red of patch.reduce) {
      const redName = red.name.toLowerCase().trim();
      const match = items.find((it) => {
        const itName = it.name.toLowerCase().trim();
        return itName.includes(redName) || redName.includes(itName);
      });
      if (match) {
        match.quantity = Math.max(0, match.quantity - red.quantity);
      }
    }
    items = items.filter((it) => it.quantity > 0);
  }

  // 3. Set quantity (fijar cantidad exacta)
  if (patch.setQuantity && patch.setQuantity.length > 0) {
    for (const sq of patch.setQuantity) {
      const sqName = sq.name.toLowerCase().trim();
      const match = items.find((it) => {
        const itName = it.name.toLowerCase().trim();
        return itName.includes(sqName) || sqName.includes(itName);
      });
      if (match) {
        match.quantity = sq.quantity;
      }
    }
    items = items.filter((it) => it.quantity > 0);
  }

  // 4. Add (sumar cantidad o agregar nuevo)
  if (patch.add && patch.add.length > 0) {
    for (const newItem of patch.add) {
      const newName = newItem.name.toLowerCase().trim();
      const match = items.find((it) => {
        const itName = it.name.toLowerCase().trim();
        return itName === newName || itName.includes(newName) || newName.includes(itName);
      });
      if (match) {
        match.quantity += newItem.quantity;
      } else {
        items.push({ ...newItem });
      }
    }
  }

  return items;
}

/**
 * Parser determinístico para frases de modificación de pedidos:
 * - Reemplazo: "cambiá las de carne por pollo", "cambiá la pizza por una mila"
 * - Fijar cantidad: "dejá solo 6 de carne", "deja 6 de carne"
 * - Restar cantidad: "bajale 2 a las empanadas", "sacale 2 de carne", "restale 2 a carne"
 * - Quitar total: "sacá la pizza", "sin pizza", "eliminá la pizza", "cancelá la mila"
 * - Sumar: "sumale 2 de pollo", "agregá 1 pizza", "+2 carne"
 */
export function parseModificationText(text: string, currentItems?: SaleLineInput[]): OrderPatch | null {
  const t = text.trim();
  const lower = t.toLowerCase();

  const add: SaleLineInput[] = [];
  const remove: string[] = [];
  const reduce: Array<{ name: string; quantity: number }> = [];
  const setQuantity: Array<{ name: string; quantity: number }> = [];

  // 1. Reemplazo: "cambiá X por Y"
  const changeMatch = lower.match(
    /(?:cambi[aá]|reemplaz[aá])\s+(?:la\s+|el\s+|las\s+|los\s+)?(?:(\d+)\s+)?(?:de\s+)?([a-zñáéíóú\s]+?)\s+por\s+(?:una\s+|un\s+|las\s+|los\s+)?(?:(\d+)\s+)?(?:de\s+)?([a-zñáéíóú\s]+)/i
  );
  if (changeMatch) {
    const explicitQtyFrom = changeMatch[1] ? parseInt(changeMatch[1], 10) : undefined;
    const fromName = changeMatch[2].trim();
    const explicitQtyTo = changeMatch[3] ? parseInt(changeMatch[3], 10) : undefined;
    const toName = changeMatch[4].trim();

    let qty = explicitQtyTo ?? explicitQtyFrom;
    if (!qty && currentItems) {
      const match = currentItems.find((it) => {
        const itName = it.name.toLowerCase();
        return itName.includes(fromName) || fromName.includes(itName);
      });
      if (match) qty = match.quantity;
    }

    remove.push(fromName);
    add.push({ name: toName, quantity: qty ?? 1 });
    return { add, remove };
  }

  // 2. Fijar cantidad: "dejá solo 6 de carne", "deja 6 de carne", "solo 6 de carne"
  const setRegex = /(?:dej[aá]\s+(?:solo\s+)?|solo\s+)(\d+)\s+(?:de\s+|a\s+)?(?:la\s+|el\s+|las\s+|los\s+)?([a-zñáéíóú\s]+?)(?:$|\s*(?:y|,|\.))/gi;
  let setMatch: RegExpExecArray | null;
  while ((setMatch = setRegex.exec(lower)) !== null) {
    const qty = parseInt(setMatch[1], 10);
    const name = setMatch[2].replace(/^(?:la|el|las|los|de|a)\s+/i, '').trim();
    if (name) {
      setQuantity.push({ name, quantity: qty });
    }
  }

  // 3. Restar cantidad: "bajale 2 a las empanadas", "sacale 2 de carne", "restale 2 a carne", "menos 2 de carne"
  const reduceRegex = /(?:bajal[eé]|baja|bajá|restal[eé]|resta|restá|sacal[eé]|sacá|saca|quital[eé]|quitá|quita|menos|-)\s+(\d+)\s*(?:a\s+|de\s+)?(?:la\s+|el\s+|las\s+|los\s+)?([a-zñáéíóú\s]+?)(?:$|\s*(?:y|,|\.))/gi;
  let redMatch: RegExpExecArray | null;
  while ((redMatch = reduceRegex.exec(lower)) !== null) {
    const qty = parseInt(redMatch[1], 10);
    const name = redMatch[2].replace(/^(?:la|el|las|los|de|a)\s+/i, '').trim();
    if (name) {
      reduce.push({ name, quantity: qty });
    }
  }

  // 4. Quitar total: "sacá la pizza", "sin pizza", "eliminá la pizza", "cancelá la mila"
  // (solo si no fue consumido por reduce con número)
  const removeRegex = /(?:sacal[eé]|sacá|saca|sacar|quital[eé]|quitá|quita|quitar|borr[aá]|borrar|elimin[aá]|eliminar|cancel[aá]|cancelar|sin)\s+(?:la\s+|el\s+|las\s+|los\s+|una\s+|un\s+)?([a-zñáéíóú\s]+?)(?:$|\s*(?:y|,|\.))/gi;
  let remMatch: RegExpExecArray | null;
  while ((remMatch = removeRegex.exec(lower)) !== null) {
    const name = remMatch[1].replace(/^(?:la|el|las|los|de|a)\s+/i, '').trim();
    // Evitar capturar si ya fue procesado como reducción numérica
    if (name && !reduce.some((r) => r.name.includes(name) || name.includes(r.name))) {
      remove.push(name);
    }
  }

  // 5. Sumar / agregar: "sumale 2 de pollo", "agregá 1 pizza", "+2 carne"
  const addRegex = /(?:sumal[eé]|suma|sumá|agregal[eé]|agrega|agregá|\+)\s*(?:(\d+)\s+)?(?:de\s+|una\s+|un\s+)?(?:la\s+|el\s+|las\s+|los\s+)?([a-zñáéíóú\s]+?)(?:$|\s*(?:y|,|\.))/gi;
  let addMatch: RegExpExecArray | null;
  while ((addMatch = addRegex.exec(lower)) !== null) {
    const qty = addMatch[1] ? parseInt(addMatch[1], 10) : 1;
    const name = addMatch[2].replace(/^(?:la|el|las|los|de|a)\s+/i, '').trim();
    if (name) {
      add.push({ name, quantity: qty });
    }
  }

  if (add.length > 0 || remove.length > 0 || reduce.length > 0 || setQuantity.length > 0) {
    return {
      add: add.length > 0 ? add : undefined,
      remove: remove.length > 0 ? remove : undefined,
      reduce: reduce.length > 0 ? reduce : undefined,
      setQuantity: setQuantity.length > 0 ? setQuantity : undefined,
    };
  }

  return null;
}
