# ADR-010: Admin web interno (`/admin`)

- **Estado:** aceptado (2026-10-07)
- **Contexto:** `CONSTITUTION.md` §11 y `ARCHITECTURE.md` §18 dejan el dashboard
  web fuera de alcance "hasta que un caso real lo exija". El caso apareció: el
  alta de negocios y la generación de invitaciones se hacen por CLI recurrentemente
  (`pnpm seed`, `pnpm invite`) y solo el dueño del repo con terminal puede
  operarlos. Es ops manual, frecuente y con riesgo de error.
- **Decisión:** admin web mínimo y **interno** dentro del mismo proceso Express ya
  desplegado (router en `src/app/admin/`, montado en `/admin`), sin infra nueva,
  sin build de front y sin tabla de usuarios: una única `ADMIN_PASSWORD` en env y
  cookie de sesión firmada HMAC con `API_SECRET`. Alcance: lista/alta de negocios,
  detalle, invitaciones (crear/revocar, deep link visible una sola vez) y cambio
  manual de estado. No es producto para clientes ni reemplaza el bot/API.
- **Consecuencias:**
  - Se abre `ARCHITECTURE.md` §18 **solo** para esta herramienta interna de ops.
  - Password compartida: cambiar `ADMIN_PASSWORD` mata todas las sesiones (la
    cookie lleva un fingerprint de la password).
  - Rate limit y sesiones son in-memory/stateless: válido porque hay **un solo
    proceso** (mismo supuesto del sistema); si algún día hay 2 réplicas, revisar.
  - No hay "logout global" por servidor: se cubre rotando la password; lo demás
    es expiración de 12 h.
  - Todo lo mutante queda auditado con acción `admin.*` y `actorUserId: null`
    (no hay usuario, viaja la password).
