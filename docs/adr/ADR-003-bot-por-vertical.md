# ADR-003: Un bot por vertical, registro estático

- **Estado:** aceptado (2026-10-06)
- **Contexto:** cada vertical debe sentirse un producto independiente; no queremos
  multi-bot dinámico por cliente ni la fricción de BotFather por trial.
- **Decisión:** un bot por vertical (Gastos, Kiosco, …), cada uno atado a su template,
  registrado estáticamente en config/composition root (un token por vertical).
  Sin tabla/infra de bots dinámicos en esta etapa.
- **Consecuencias:** agregar un bot = agregar una línea de config + template. Si un
  cliente exige bot propio, se evalúa entonces (el diseño lo permite sin rehacer Core).
