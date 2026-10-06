# ADR-004: Tablas tipadas por template, sin `Record` genérico

- **Estado:** aceptado (2026-10-06)
- **Contexto:** cómo modelar datos específicos por vertical (ventas, turnos, gastos…).
- **Decisión:** tablas tipadas con `businessId` + FKs + constraints; `metadata JSONB`
  solo para extensiones menores. Prohibida la tabla genérica `Record{type,jsonData}`
  como modelo principal. Conceptos compartidos (`MoneyMovement`, etc.) suben a Core
  solo cuando 2 templates los necesiten idénticos.
- **Consecuencias:** más migraciones por template, pero consultas/reportes simples,
  integridad referencial real y tipado en toda la cadena.
