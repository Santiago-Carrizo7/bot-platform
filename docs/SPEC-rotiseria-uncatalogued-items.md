# SPEC TÉCNICO: Productos No Catalogados sin Bloqueo y Ampliación de Anulación a 10 Ventas (`rotiseria`)

## 1. Diagnóstico del Problema y Objetivos

### A. Bloqueo Fatal en Productos No Catalogados
- **Situación actual:** En `src/templates/rotiseria/domain/pricing.ts`, si un ítem solicitado o modificado (ej: "agregá flan", "sumá ensalada rusa") no existe en `RotiseriaProduct` ni `RotiseriaPromo`, `calculatePricing` lanza un `AppError: "No encontré estos productos/promos: [...]"`.
- **Efecto adverso:** Cuando el usuario confirma el pedido (`confirm:yes`), `SaleService.createSale` vuelve a invocar `calculatePricing` y la operación aborta con error, impidiendo a la cocina emitir la comanda y cobrar.
- **Objetivo:** Eliminar el lanzamiento de `AppError` por ítems faltantes. Si un producto no está en la base, se resuelve como ítem especial (`productId: null`, `promoId: null`, categoría `'especial'`, precio unitario $0 o manual). Se brinda la opción interactiva de asignarle precio (`[ 💵 Asignar precio a '<ítem>' ]`) sin bloquear el botón `[ ✅ Confirmar venta ]`.

### B. Límite de 5 Ventas en Anulación
- **Situación actual:** La acción `anular_venta` solo ofrece `[ 📋 Elegir de las últimas 5 ventas ]`, dejando inaccesibles ventas erróneas de turnos con alta rotación de comandas.
- **Objetivo:** Ofrecer selector de `[ 📋 Últimas 5 ventas ]` y `[ 📋 Últimas 10 ventas ]`. En el menú de callback `rotiseria:anular_listar:<limit>`, listar interactivamente hasta 10 ventas activas para anular con un toque.

---

## 2. Arquitectura de Cambios por Componente

### 1. Tipos y Dominio (`types.ts` & `domain/pricing.ts`)
- **`types.ts`:**
  - `SaleLineInput`: agregar `unitPrice?: number`.
  - `PricingResult`: agregar `uncataloguedItems?: Array<{ name: string; quantity: number; unitPrice?: number }>`.
  - `DraftSaleData`: agregar `_awaitingItemPriceFor?: string | null` y `_uncataloguedZeroItems?: Array<{ name: string; quantity: number }>`.
- **`domain/pricing.ts`:**
  - Eliminar `if (missing.length > 0) throw new AppError(...)`.
  - Si un ítem no coincide con promos ni productos:
    ```typescript
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

    if (unitPrice === 0) {
      breakdown.push(`• ${formatQty(item.quantity)}x *${esc(item.name.trim())}* — $0 (⚠️ Ítem especial / sin precio en carta)`);
    } else {
      breakdown.push(`• ${formatQty(item.quantity)}x *${esc(item.name.trim())}* — *${formatCurrency(subtotal)}* (Ítem especial)`);
    }
    ```

### 2. Formatters y Acciones (`format.ts` & `actions.ts`)
- **`format.ts`:**
  - En `formatSaleSummary`: asegurar que si `total === 0` se visualice `💰 *Total:* *$ 0*` en lugar de omitirse.
- **`actions.ts`:**
  - En `registrarVenta.summarize`: propagar `it.precio_unitario` hacia `calculatePricing` y almacenar `_uncataloguedZeroItems`.
  - En `registrarVenta.confirmButtons`:
    - Si existen ítems no catalogados con precio $0, agregar botones secundarios: `[ 💵 Asignar precio a '<nombre>' ]` con callback `rotiseria:precio_item:<nombre>`.
    - Fila de confirmación principal (`[ ✅ Confirmar venta ]` | `[ ❌ Cancelar ]`) siempre disponible.
  - En `anularVenta`:
    - Reemplazar botón de 5 ventas por fila con `[ 📋 Últimas 5 ventas ]` (`rotiseria:anular_listar:5`) y `[ 📋 Últimas 10 ventas ]` (`rotiseria:anular_listar:10`).

### 3. Telegram Interceptores y Callbacks (`src/templates/rotiseria/index.ts`)
- **Callback `rotiseria:precio_item:<nombre>`:**
  - Pone en `COLLECTING` con `{ _awaitingItemPriceFor: rawName }`.
  - Mensaje: *"¿Qué precio unitario tiene **<nombre>**? Escribí el monto (ej: *2500*):"*.
- **En `interpretDirectly`:**
  - Si `activeData?._awaitingItemPriceFor` está activo y el usuario escribe un monto (número directo o terminación `k`):
    - Actualizar `precio_unitario` del ítem en `items[]`.
    - Resetear flag y re-cotizar pedido.
- **Callback `rotiseria:anular_listar` / `rotiseria:anular_listar:<limit>`:**
  - Parsear límite (default 10).
  - Consultar `sales.listRecentSales(businessId, limit)` y desplegar botones para anular ventas activas.
  - Soportar `rotiseria:anular_pedido:<id>` y `rotiseria:anular_ver:<id>` para abrir la confirmación de anulación.

---

## 3. Plan de Implementación en 5 Fases

| Fase | Tarea | Archivos | Verificación |
|---|---|---|---|
| **Fase 1** | Soporte de ítems especiales en tipos y cotización de precios sin lanzar `AppError` | `src/templates/rotiseria/types.ts`, `src/templates/rotiseria/domain/pricing.ts` | Unit tests de pricing con productos inexistentes |
| **Fase 2** | Adaptación de formatters y botones de confirmación en `registrarVenta` | `src/templates/rotiseria/format.ts`, `src/templates/rotiseria/actions.ts` | Previsualización y recibo con ítems a $0 y botones de asignación |
| **Fase 3** | Ampliación de selector de anulación (5 y 10 ventas) y callbacks | `src/templates/rotiseria/actions.ts`, `src/templates/rotiseria/index.ts` | Menú interactivo de anulación con lote de 10 |
| **Fase 4** | Schemas Zod e interceptor interactivo para asignar precio a ítems libres | `src/templates/rotiseria/schemas.ts`, `src/templates/rotiseria/index.ts` | Flujo de ingreso manual de precio por mensaje de texto |
| **Fase 5** | Suite de tests automatizados (3 nuevos casos) y Quality Gates | `tests/rotiseria.test.ts`, `MEMORY.md` | `pnpm typecheck && pnpm test && pnpm build` |
