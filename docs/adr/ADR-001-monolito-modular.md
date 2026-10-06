# ADR-001: Monolito modular en un solo paquete

- **Estado:** aceptado (2026-10-06)
- **Contexto:** equipo de 2 devs, un deploy, sin consumidores externos del Core.
- **Decisión:** un solo paquete npm (`core/`, `infrastructure/`, `templates/`, `app/`),
  un proceso, una DB. Sin monorepo/workspaces, sin microservicios.
- **Consecuencias:** deploys simples; si algún día hay consumidores externos, se extrae
  el Core. No se fragmenta el repo por anticipación.
