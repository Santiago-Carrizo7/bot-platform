# ADR-006: Structured output con dispatch; tool calling después

- **Estado:** aceptado (2026-10-06)
- **Contexto:** evolucionar `ExpenseParser` (prompt → JSON → Zod) a N acciones sin
  diseñar un framework de agentes.
- **Decisión:** v1 = el modelo devuelve `{action, params}`; el código valida contra
  whitelist + schema Zod de la acción (1 reintento de reparación). `IAIProvider`
  expone un método opcional de tools sin usar.
- **Consecuencias:** cambio mínimo desde el código actual, compatible con cualquier
  proveedor de texto. Adoptar tool calling nativo = cambiar el adaptador, no los
  templates.
