# SPEC: Soporte de Zonas de Envío y Flete (Template `rotiseria`)

**Estado:** Propuesto (Pendiente de Aprobación)  
**Fecha:** 2026-10-10  
**Autor:** Antigravity / Pair Programming  
**Módulo:** `src/templates/rotiseria/`  
**Referencia:** `CONSTITUTION.md`, `AGENTS.md`, ADR-002 (Multi-tenancy), ADR-011 (Templates Verticales)

---

## 1. Objective

Incorporar gestión integral de envíos a domicilio (delivery) y cálculo transparente de flete para el template gastronómico `rotiseria`:
1. Permitir al comercio configurar sus zonas de entrega y barrios asociados con tarifas planas por zona, soportando flete bonificado ($0 / gratis).
2. Asignar automáticamente el costo de flete cuando un cliente o comanda mencione una zona o barrio conocido.
3. Brindar asistencia interactiva cuando se mencione una zona o barrio no reconocido, permitiendo cotizar la comida de inmediato y asignar el monto de flete manualmente o mediante botones inline.
4. Segregar contablemente la recaudación del local: separar la venta neta de comida (`foodTotal`) de la cadetería acumulada (`deliveryTotal`) y conteo de despachos con delivery (`deliveryOrdersCount`) en los reportes de turno y estadísticas periódicas.
5. Mantener la frontera arquitectónica cerrada: 0 modificaciones a `src/core/` o `src/infrastructure/`.

---

## 2. Tech Stack & Commands

- **Runtime:** Node.js 20+ (ESM con extensiones `.js`).
- **Lenguaje:** TypeScript 5+ (`strict`, `NodeNext`).
- **Base de Datos & ORM:** PostgreSQL 16 + Prisma ORM.
- **Validación:** Zod.
- **Test Runner:** vitest (Fakes en memoria para aislamiento y velocidad).

### Comandos de Validación & Calidad (Quality Gates)
```bash
# Typecheck estricto sin emitir código
pnpm typecheck

# Suite de pruebas unitarias (177+ tests)
pnpm test

# Build de producción TypeScript a dist/
pnpm build

# Migración de Prisma para entrega
pnpm prisma migrate dev --name add_rotiseria_delivery_zones
pnpm prisma generate
```

---

## 3. Project Structure

```
prisma/
  schema.prisma                            # Modelos RotiseriaDeliveryZone y campos en RotiseriaSale
  migrations/
    20261010150000_add_rotiseria_delivery_zones/
      migration.sql                        # DDL de tabla e índices

src/templates/rotiseria/
  domain/
    pricing.ts                             # PricingResult discriminando foodTotal, deliveryFee, deliveryZoneName
    delivery-zone.service.ts               # Lógica de matching flexible, normalización y cálculo de flete
    sale.service.ts                        # createSale con deliveryZoneName y deliveryFee
    stats.service.ts                       # Segregación contable foodTotal vs deliveryTotal vs deliveryOrdersCount
  persistence/
    delivery-zone.repo.ts                  # Acceso tenant-scoped (upsertBatch, listActive, findMatching, deactivate)
    sale.repo.ts                           # Persistencia de deliveryZoneName y deliveryFee en rotiseria_sales
  actions.ts                               # Acciones configurar_envios_lote, gestionar_envios y registrar_venta
  prompts.ts                               # Reglas LLM para extracción de flete/zona y prompt de lote
  schemas.ts                               # ConfigurarEnviosLoteInput y extensión de RegistrarVentaInput
  types.ts                                 # Interfaces tipadas (DeliveryZone, PricingResult, StatsSummary, DaySummary)
  format.ts                                # Formato de comanda y resumen con desglose de flete
  index.ts                                 # Registro de /envios, interceptores _awaitingManualFee y resolveHints

tests/
  rotiseria.test.ts                        # Suite de pruebas con FakeRotiseriaDeliveryZoneRepo
```

---

## 4. Code Style & Convenciones

### A. Tipado de Flete ($0 vs null)
En TypeScript y Postgres, diferenciamos estrictamente:
- `deliveryFee === null` $\rightarrow$ Sin envío (retiro en mostrador / consumo en salón).
- `deliveryFee === 0` $\rightarrow$ Envío bonificado / Delivery ¡GRATIS! ($0).
- `deliveryFee > 0` $\rightarrow$ Delivery con cargo tarifado.

```ts
export interface PricingResult {
  lines: ResolvedSaleLine[];
  foodTotal: number;
  deliveryFee: number | null;
  deliveryZoneName: string | null;
  total: number;
  breakdown: string[];
}
```

### B. Normalización y Matching Flexible
Búsqueda insensible a mayúsculas, minúsculas, espacios sobrantes y acentos (diacríticos) para nombres de zonas y barrios:
```ts
export function normalizeQuery(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}
```

---

## 5. Testing Strategy

1. **Test Fakes en Memoria:**
   - Crear `FakeRotiseriaDeliveryZoneRepo` en `tests/rotiseria.test.ts`.
   - Modificar `FakeRotiseriaSaleRepo` para recibir y almacenar `deliveryZoneName` y `deliveryFee`.
2. **Casos de Prueba Unitarios Obligatorios:**
   - **Caso 1: Cotización con zona de catálogo:** Pedido de 12 empanadas + zona "Tres Cerritos" ($2.500) $\rightarrow$ total = $15.000 + $2.500 = $17.500, con línea `🛵 Envío (Tres Cerritos): $ 2.500`.
   - **Caso 2: Envío bonificado ($0 / gratis):** Zona "Microcentro" ($0) $\rightarrow$ total = $15.000, con línea `🛵 Envío (Microcentro): ¡GRATIS! ($0)`, registrando `deliveryFee: 0` y no `null`.
   - **Caso 3: Barrio desconocido (desambiguación interactiva):** Pedido con zona no reconocida "Barrio Aeropuerto" $\rightarrow$ comida cotizada a $15.000 + botón `[ ⚠️ Asignar flete a 'Barrio Aeropuerto' ]`. Al enviar `2000`, se recalcula a $17.000.
   - **Caso 4: Configuración en lote (`configurar_envios_lote`):** Procesa texto con múltiples zonas y listas de barrios, persistiendo `barrios` en minúsculas y `price` con soporte para `$0`.
   - **Caso 5: Segregación contable en estadísticas:** Ventas con flete no alteran `foodTotal`; `deliveryTotal` y `deliveryOrdersCount` se reportan fielmente en resúmenes diarios y métricas semanales.
   - **Caso 6: Eliminación / Modificación de flete:** Usuario escribe `"sin envio"` o `0` en modo `_awaitingDelivery` $\rightarrow$ elimina el flete y restablece a retiro en mostrador.

---

## 6. Boundaries (Límites Arquitectónicos)

- **Always Do:**
  - `businessId NOT NULL` en toda consulta o mutación de zonas de entrega.
  - Conversión de Prisma `Decimal` a `Number` con `round2` en bordes de aplicación.
  - Auditar `delivery_zone.created`, `delivery_zone.updated`, `delivery_zone.batch_configured`, `delivery_zone.deactivated`.
  - Quality gates limpios (`typecheck`, `test`, `build`).
- **Ask First:**
  - Nuevas dependencias externas (no se requieren; Zod, Prisma y TS cubren todo).
  - Cambios en el Core (`src/core/`) o en `src/infrastructure/` (estrictamente prohibidos en este spec).
- **Never Do:**
  - Confundir `deliveryFee === 0` con `deliveryFee === null`.
  - Distorsionar la recaudación de comida sumando el flete al ticket gastronómico en estadísticas.
  - Modificar tablas de otros templates (`kiosco`, `gastos`).

---

## 7. Success Criteria

- [ ] Migración limpia en `prisma/schema.prisma` (`RotiseriaDeliveryZone` + campos en `RotiseriaSale`).
- [ ] Repositorio y Servicio de zonas de envío implementados con matching por zona y barrios.
- [ ] `calculatePricing` desglosa `foodTotal`, `deliveryFee`, `deliveryZoneName` y `total`.
- [ ] Acciones `/envios`, `configurar_envios_lote` y comandos registrados en Telegram.
- [ ] Flujo conversacional interactivo para barrios no reconocidos (`_awaitingManualFee`, `_awaitingDelivery`).
- [ ] Estadísticas segregan `foodTotal`, `deliveryTotal` y `deliveryOrdersCount`.
- [ ] 100% de tests unitarios pasando en verde (182+ tests).
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm build` sin advertencias ni errores.
- [ ] `MEMORY.md` actualizado bajo 50-60 líneas.
