# ADR-011: Template Rotisería y Reglas de Gastronomía

- **Estado:** aceptado (2026-10-08)
- **Contexto:** las rotiserías y casas de empanadas tienen particularidades que kiosco
  no cubre: venta por docenas combinadas, promociones cerradas, turnos que cierran
  de madrugada (00:00 - 04:59 AM) y necesidad de anulación lógica rápida de tickets.
- **Decisión:**
  1. Modelo de datos propio tipado (`RotiseriaProduct`, `RotiseriaPromo`, `RotiseriaSale`, `RotiseriaSaleItem`) con `businessId` estricto y multi-tenancy.
  2. Cálculo automático de docenas: bloques de 12 unidades (individuales o combinadas entre sabores con `priceDozen`) a precio de docena; remanentes a precio unitario individual.
  3. Jornada operativa nocturna: ventas entre 00:00 y 04:59 AM se asignan al `shiftDate` del día anterior ("Cierre de anoche").
  4. Anulación lógica (`isCancelled: true`): no borra filas para preservar auditoría, y descuenta el ticket de reportes y estadísticas.
  5. Teclado inferior (`replyMenu`) fijo de 5 botones: Registrar venta, Control de días, Estadísticas, Anular venta, Cambiar precio.
- **Consecuencias:**
  - El template es autocontenido dentro de `src/templates/rotiseria/`.
  - La carga de catálogo desde `/admin` es idempotente y provee un menú base si el negocio arranca vacío.
