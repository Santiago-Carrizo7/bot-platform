# Task List: Productos No Catalogados sin Bloqueo y Ampliación de Anulación a 10 Ventas (`rotiseria`)

- [x] Task 1: Soporte de ítems especiales en tipos y cotización de precios sin lanzar AppError
  - Acceptance: `SaleLineInput` con `unitPrice?: number`; `PricingResult` con `uncataloguedItems`; `DraftSaleData` con `_awaitingItemPriceFor`. `calculatePricing` nunca lanza `AppError` por ítems faltantes, los resuelve como categoría `especial`, `productId: null`, `promoId: null` y agrega desglose ($0 o monto).
  - Verify: Unit test de pricing con productos inexistentes
  - Files: `src/templates/rotiseria/types.ts`, `src/templates/rotiseria/domain/pricing.ts`

- [x] Task 2: Adaptación de formatters y botones de confirmación en registrarVenta
  - Acceptance: `formatSaleSummary` visualiza total $0 si `total === 0`. `confirmButtons` agrega botones `[ 💵 Asignar precio a '<ítem>' ]` para ítems no catalogados a $0, manteniendo siempre habilitado `[ ✅ Confirmar venta ]`. En `handler`, `createSale` persiste ítems especiales sin error.
  - Verify: Previsualización de resumen y recibo con ítems a $0
  - Files: `src/templates/rotiseria/format.ts`, `src/templates/rotiseria/actions.ts`

- [x] Task 3: Ampliación de selector de anulación (5 y 10 ventas) y callbacks
  - Acceptance: Menú inicial de `anularVenta` ofrece `[ 📋 Últimas 5 ventas ]` (`rotiseria:anular_listar:5`) y `[ 📋 Últimas 10 ventas ]` (`rotiseria:anular_listar:10`). El callback lista hasta 10 ventas y soporta tanto `rotiseria:anular_pedido:<id>` como `rotiseria:anular_ver:<id>` para abrir confirmación.
  - Verify: Menú interactivo de anulación con lote de 10
  - Files: `src/templates/rotiseria/actions.ts`, `src/templates/rotiseria/index.ts`

- [x] Task 4: Schemas Zod e interceptor interactivo para asignar precio a ítems libres
  - Acceptance: `VentaItemSchema` acepta `precio_unitario`. `RegistrarVentaInput` acepta `_awaitingItemPriceFor`. Callback `rotiseria:precio_item:<index>` solicita monto evitando límite 64b. `interpretDirectly` captura el número (ej: 2500 o 2.5k), asigna el precio al ítem en `items[]` y re-cotiza.
  - Verify: Flujo interactivo de fijar precio a ítem libre
  - Files: `src/templates/rotiseria/schemas.ts`, `src/templates/rotiseria/index.ts`

- [x] Task 5: Suite de tests automatizados (3 nuevos casos) y Quality Gates
  - Acceptance: Actualizar aserción de teclado en test existente. Agregar 3 tests para los 3 escenarios requeridos (ítem libre persistido a $0, modificación con ítem libre + precio manual, y anulación de 10 ventas con distinción de anuladas previas). Quality gates al 100%.
  - Verify: `pnpm typecheck && pnpm test && pnpm build`
  - Files: `tests/rotiseria.test.ts`, `MEMORY.md`
