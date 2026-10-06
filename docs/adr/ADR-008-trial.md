# ADR-008: Trial de 10 días desde la primera acción real

- **Estado:** aceptado (2026-10-06)
- **Contexto:** modelo comercial con semana(+margen) de prueba; no borrar datos al vencer.
- **Decisión:** `Business.status` ∈ `TRIAL|ACTIVE|READ_ONLY|SUSPENDED`. El trial
  (10 días, configurable) lo inicia la primera escritura de dominio, nunca el alta,
  `/start`, lecturas o menú. Al expirar → `READ_ONLY` (lee, no escribe). Suscripción:
  campos de activación/vencimiento/período/tolerancia + gracia permisiva con avisos.
  Sin billing automático.
- **Consecuencias:** el pipeline evalúa estado antes de cada acción; el inicio del
  trial es un efecto lateral controlado de la primera mutación.
