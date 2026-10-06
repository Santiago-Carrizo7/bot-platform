# ADR-002: Multi-tenancy por `businessId` (shared schema)

- **Estado:** aceptado (2026-10-06)
- **Contexto:** una DB PostgreSQL para N negocios; Prisma como ORM; modelo comercial
  con trials de 1 semana (el alta debe ser un INSERT, no una operación de infra).
- **Decisión:** shared schema + `businessId NOT NULL` en toda tabla de dominio,
  uniques compuestos, índices liderados por `businessId`, repos que exigen contexto.
- **Descartado por ahora:** schema-por-tenant y DB-por-cliente (migraciones ×N,
  Prisma sin soporte cómodo, onboarding costoso). RLS solo si hay requisito formal.
- **Consecuencias:** riesgo de filtro olvidado → mitigado con repos que no se pueden
  construir sin `TenantContext` + tests de isolation + review checklist.
