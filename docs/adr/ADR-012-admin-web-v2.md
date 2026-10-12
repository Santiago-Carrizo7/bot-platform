# ADR-012 — Admin web v2: dashboard, pagos manuales, CSRF y operador auditado

- Estado: implementado 2026-10-12.
- Contexto: el admin v1 (ADR-010) cubría alta/invitaciones/estado pero sin
  visión operativa diaria: sin dashboard, sin búsqueda, sin historial de cobros,
  sin CSRF token y sin atribución (password compartida, todo "anónimo").
- Decisión:
  1. Dashboard + secciones (Negocios, Trials, Pagos, Auditoría, Config) con el
     mismo HTML server-rendered, cero dependencias nuevas.
  2. `ManualPayment` (`CONFIRMED|PENDING|VOID`, `idempotencyKey` único por
     negocio, anulación sin borrado). Un pago NUNCA cambia el estado del
     negocio; lo hace un operador vía `setStatus`, auditado.
  3. CSRF synchronizer sin store (`HMAC(sesión, API_SECRET)`) en todo POST con
     sesión; se mantienen rate-limit, Origin-check y cookie HttpOnly/SameSite.
  4. Etiqueta de operador opcional firmada en la sesión → `metadata.operator`.
     Cuentas individuales quedan como paso siguiente explícito (cambio mayor).
  5. `trialLabel` y vencimientos delegan en `evaluateAccess()` del Core: cero
     cálculos duplicados.
- Consecuencias: migración `20261012000000_manual_payments` (solo crea tabla +
  enum, no destructiva); `GET /admin/` ahora es dashboard pero incluye los
  últimos negocios (compat con flujos v1); tests 55/55 en `tests/admin.test.ts`.
