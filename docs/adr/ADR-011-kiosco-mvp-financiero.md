# ADR-011: Rediseño Kiosco — MVP Financiero (sin stock/inventario)

- **Estado:** aceptado (2026-10-08) — Reemplaza y deroga ADR-009.
- **Contexto:** El template `kiosco` inicial incluía control de stock, inventario y catálogo
  de productos. Esto imponía fricción de alta y alejaba al producto de su valor central:
  un asistente financiero ágil para el dueño del kiosco.
- **Decisión:**
  1. Eliminar inventario, productos y stock del MVP.
  2. Enfocar el bot en flujo de caja: registrar ventas rápidas (dinero que entra), gastos
     y compras a proveedores (dinero que sale), calculador de precios (margen vs recargo)
     y estadísticas de caja (hoy, semana, mes, movimientos).
  3. Toda la operatoria financiera de kiosco se modela sobre `MoneyMovement` (`IN`/`OUT`).
  4. Soportar modo continuo (`/ventas`, `/gastos`, `/fin`, `undo:last`) con registro inmediato
     y acción rápida de "Deshacer" (`deshacer_ultimo`), manteniendo confirmación Sí/No en el
     modo normal.
  5. El resultado de caja (`Ventas - Gastos`) se comunica claramente como balance de caja
     registrado, distinguiéndolo de "ganancia real" contable.
- **Consecuencias:** Cero fricción de carga inicial de catálogo. Flujo rápido y amigable
  por Telegram (texto y audio). Simplificación masiva del modelo y eliminación de tablas
  obsoletas (`products`, `sales`, `sale_items`, `purchases`, `stock_movements`).
