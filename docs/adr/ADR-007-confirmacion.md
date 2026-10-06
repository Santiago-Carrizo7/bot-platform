# ADR-007: Confirmación obligatoria en mutaciones

- **Estado:** aceptado (2026-10-06)
- **Contexto:** la IA interpreta; puede equivocarse. Regla de producto.
- **Decisión:** toda `Action` de escritura pasa por confirmación explícita antes de
  tocar DB (bot: paso visible Sí/No con el resumen de lo entendido; API: la request
  autenticada y estructurada es la confirmación). Las lecturas no la requieren.
- **Consecuencias:** el pipeline distingue `kind: 'read' | 'write'`; el estado de
  conversación guarda el pendiente a confirmar con TTL corto.
