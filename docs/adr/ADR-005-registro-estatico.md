# ADR-005: Templates como módulos estáticos, sin plugins

- **Estado:** aceptado (2026-10-06)
- **Contexto:** cómo registrar templates sin construir un sistema de plugins.
- **Decisión:** los templates son módulos TypeScript normales importados
  estáticamente en `src/app/container.ts`. Sin `import()` dinámico, sin registro en
  runtime, sin descubrimiento por convención.
- **Consecuencias:** tipos completos, refactors seguros, bundle simple. Agregar un
  template = crear carpeta + 1 import. Suficiente mientras los clientes no suban código
  (no es el caso).
