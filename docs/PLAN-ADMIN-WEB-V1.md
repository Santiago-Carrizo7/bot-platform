# Plan: Admin web v1 (`/admin`) — dashboard interno de operaciones

- **Estado:** listo para implementar (diseñado 2026-10-06).
- **Para el agente que lo ejecute:** leé primero `AGENTS.md` → `MEMORY.md` →
  `CONSTITUTION.md`, después este plan completo. Cada slice se verifica con los
  3 gates (`pnpm typecheck` + `pnpm test` con `TEST_DATABASE_URL` del punto 10 +
  `pnpm build`) y termina en commit. Al finalizar, actualizar `MEMORY.md`.

---

## 1. Contexto & objetivo

Hoy el alta de negocios e invitaciones se hace por CLI (`pnpm seed`, `pnpm
invite`) — solo el dueño del repo puede, con terminal. La web v1 reemplaza eso
con una UI en el **mismo proceso Express de Render** (cero infra nueva), para:
crear negocios, generar links de invitación a mano, y mirar/gestionar el estado
de los negocios.

**Salida del alcance de CONSTITUTION §11 ("sin dashboard web… hasta que un caso
real lo exija"): el caso real apareció (ops manual recurrente) → primero se
documenta (ADR-010), después se implementa.** Ese es exactamente el protocolo de
la constitución, no una excepción.

## 2. Alcance v1

**Sí:**

- Login con contraseña compartida (una sola, en env).
- Lista de negocios (nombre, template, estado, trial restante, fecha de alta).
- Alta de negocio (nombre, template, timezone/currency con defaults) + correr
  `seedBusiness` del template (hoy: gastos crea categorías default; kiosco no
  hace nada — inofensivo).
- Detalle de negocio: datos, miembros vinculados (telegramId + rol),
  invitaciones con estado (pendiente/usada/revocada/expirada).
- Crear invitación OWNER/EMPLOYEE con días a elegir → muestra el deep link
  **una sola vez** (la DB solo guarda el hash) + botón copiar + revocar.
- Cambiar estado manual (`TRIAL|ACTIVE|READ_ONLY|SUSPENDED`) — útil para
  suspender/apelar trial vencido.
- Logout.

**No (v2+):** métricas/ventas, edición de datos de negocio, multi-admin con
usuarios, reset de trial, BFF/SPA, IP allowlist.

## 3. Decisiones de diseño

| Tema | Decisión | Por qué |
|---|---|---|
| Dónde vive | Router Express en `src/app/admin/` montado en `/admin` del server actual | Cero infra; ya desplegado y despierto |
| Frontend | HTML server-rendered (template literals + CSS inline), forms nativos, redirect-after-POST | Rápido, 0 dependencias, 0 build step |
| Auth | `ADMIN_PASSWORD` (env, min 16) + cookie de sesión firmada HMAC con `API_SECRET` | Sin tabla de usuarios, sin sesiones en DB |
| Cookie | `HttpOnly`, `SameSite=Strict`, `Path=/admin`, `Secure` cuando `x-forwarded-proto=https`, expira 12h | Defensa en profundidad |
| Rotar password | La cookie lleva `pwdFp = sha256(ADMIN_PASSWORD)` (8 hex) y se valida al verificar → cambiar la env **mata todas las sesiones** | Sin store server-side podés "revocar" |
| Rate limit login | 5 fallos / 10 min / IP → 429, in-memory | Un solo proceso (mismo límite que el resto del sistema) |
| CSRF | Solo aceptar POST con `Origin`/`Referer` == host (junto a `SameSite=Strict`) | Sin token infra para forms server-rendered |
| Comparación de password | `timingSafeEqual` sobre SHA-256 | Sin leak por timing/longitud |
| Default ausente | Sin `ADMIN_PASSWORD` → `/admin` responde 404 | Nunca queda abierto sin querer |
| Sin dependencias nuevas | Cookies/HTML/rate-limit a mano; solo `express.urlencoded` built-in | Regla de mínima infra |

## 4. Estructura de archivos

```
NUEVOS
  docs/adr/ADR-010-admin-web-interna.md     contexto/decisión/consecuencias
  src/app/admin/router.ts                   createAdminRouter(deps): Express Router + guard
  src/app/admin/session.ts                  sign/verify de la cookie (HMAC API_SECRET)
  src/app/admin/pages.ts                    HTML de: login, lista, detalle, formularios
  tests/admin.test.ts                       tests de la tanda

CAMBIOS
  src/core/config/config.ts                 + ADMIN_PASSWORD (z.string().min(16).optional())
  src/core/persistence/repositories.ts      + IBusinessRepository.listAll()
  src/infrastructure/persistence/…          + listAll() en PrismaBusinessRepository
  tests/fakes.ts                            + listAll() en FakeBusinessRepo
  src/infrastructure/http/server.ts         + dep adminRouter?: Router → app.use('/admin', …)
                                             (antes del error handler, igual que extraRoutes)
  src/app/container.ts                      + buildAdminRouter(core, config, …) — recibe de
                                             composition root los callbacks (ver §6)
  src/app/index.ts                          montar admin si config.ADMIN_PASSWORD
  .env.example, docs/OPERACIONES.md (§ nueva), README, MEMORY, ARCHITECTURE §18 (nota)
```

**Límite de arquitectura:** el admin router es app-level y recibe los dos
callbacks concretos (seeds, botUsername) desde el composition root — nunca
importa templates ni Telegram directo. `core` no se entera de que existe la web.

## 5. Endpoints (montados en `/admin`, con `express.urlencoded` propio — la API `/api` no se toca)

```
GET  /admin/login                          form (si ya hay cookie válida → 302 /admin/)
POST /admin/login                          rate-limited; OK → cookie + 302; FAIL → 401 con form
POST /admin/logout                         borra cookie (Max-Age=0) → 302 login
GET  /admin/                               lista de negocios (requiere sesión)
POST /admin/businesses                     {name, templateId} → crea + seed → 302 detalle
GET  /admin/businesses/:id                 detalle + miembros + invitaciones
POST /admin/businesses/:id/invitations     {role, days} → crea → 302 detalle con deep link (flash)
POST /admin/invitations/:id/revoke         → 302 detalle
POST /admin/businesses/:id/status          {status} → audita → 302 detalle
```

Mismo shape de respuesta que la API (`{error, message}`) para errores; éxito =
redirect (PRG). El deep link solo viaja en el HTML del redirect (flash en query
corta o render inline), nunca se persiste plaintext.

## 6. Reuso concreto (lo que ya existe en el repo)

- **Crear negocio:** `core.businesses.create({name, templateId})`
  (`BusinessService` ya existe) + `seedBusiness` del template vía callback
  `{[templateId]: (id) => Promise<void>}` pasado por `index.ts` (mismo patrón
  que `scripts/seed.ts`).
- **Invitaciones:** `core.invitations.create(businessId, role, {ttlHours,
  botUsername})` → devuelve `deepLink`; `core.invitations.revoke(...)`. Ambos ya
  auditan.
- **botUsername:** resolver lazy con cache `configuredBots(config)` + `getMe()`
  (copia de `scripts/invite.ts`); si no hay token para ese template → error
  amigable "configurá `TELEGRAM_BOT_TOKEN_X`". Funciona incluso con
  `TELEGRAM_POLLING=off` (probar admin local).
- **Miembros:** `core.memberships.listByBusiness(id)` ya existe.
- **Estado:** `core.businesses.setStatus(id, status)` ya existe.
- **Guard:** patrón de `createAuthMiddleware` en `server.ts` (timingSafeEqual,
  errores centralizados).
- **Auditoría:** `AuditService.log({businessId, actorUserId: null, action:
  'admin.*', metadata})` en cada POST mutante (CONSTITUTION §9: quién/cuándo —
  "admin" viajando con la password).

## 7. Seguridad (checklist de CONSTITUTION §9 / AGENTS.md §6)

- Secrets solo en env; password nunca en logs ni HTML; intentos de login
  logueados sin password.
- Cookie HttpOnly+SameSite+Secure (detectado por `x-forwarded-proto`); firma
  con `timingSafeEqual`; expiración 12h; rotar `ADMIN_PASSWORD` invalida todas.
- 404 si no hay password configurada; rate limit en login; check de Origin en
  POST.
- Sin `x-user-id`, sin bypasses: el admin es un rol aparte de la auth de
  tenants, no un tenant.
- AuditLog de toda mutación; sin PII de clientes (solo `telegramId`, que es lo
  que ya muestra el CLI).

## 8. Documentación (obligatoria antes de implementar — AGENTS.md §9.5)

- **ADR-010**: contexto (CONSTITUTION §11 y ARCHITECTURE §18 lo ponen en
  no-alcance; CLI manual recurrente es el caso real), decisión (admin interno
  mínimo, misma app, contraseña única, sin usuarios en DB), consecuencias (abre
  §18 solo para herramienta interna de ops; no es producto para clientes).
- **ARCHITECTURE §18**: nota → "dashboard web: solo admin interno de ops, ver
  ADR-010".
- **OPERACIONES.md**: § nueva (entrar, crear negocio, generar/revocar link,
  rotar password, qué hacer si perdés la password).
- `MEMORY.md`, `README.md`.

## 9. Tests

Gates: `pnpm typecheck` + `pnpm test` + `pnpm build` (ver punto 10 para la DB).

1. `session.ts`: firma/verificación, expiración, cookie tampeada, **rotar
   password invalida sesión**.
2. Login: rate limit (6º fallo → 429), password correcta/incorrecta con
   `timingSafeEqual`.
3. Guard: sin cookie → 302 a login; con cookie → 200; sin `ADMIN_PASSWORD` →
   404.
4. Flujo con fakes en memoria (patrón de `tests/fakes.ts`): crear negocio →
   está en el repo; crear invitación → `deepLink` presente; revocar → estado.
5. POST con `Origin` externo → 403.
6. Smoke: `/admin` sin password → 404 (no romper el smoke actual).

## 10. Orden de ejecución (5 slices, cada uno con gates verdes)

1. **ADR-010 + config + `session.ts` + tests de session** (todo lo security
   primero).
2. **`listAll` en repositorio (core+prisma+fake) + router con login/guard/
   rate-limit + `server.ts` mount + tests de guard** → login funcionando.
3. **Páginas lista + alta de negocio (con seeds) + detalle** → ya se crean
   negocios desde la web.
4. **Invitaciones (crear/mostrar deep link/revocar) + cambio de estado +
   miembros + audit** → reemplaza `pnpm invite`.
5. **Docs (OPERACIONES/README/MEMORY/ARCHITECTURE) + smoke + gates + commit.**

Para correr los tests con DB local: Docker Desktop arriba,
`docker compose up -d` y
`TEST_DATABASE_URL="postgresql://postgres:postgrespassword@localhost:5432/bot_platform_test?schema=public"`
antes de `pnpm test`.

## 11. Deploy (pasos del usuario, al final)

1. Render → Environment: `ADMIN_PASSWORD` (generar uno fuerte, min 16 chars).
2. Push → deploy → entrar a `https://<app>/admin/` con la password.
3. Verificar: crear un negocio de prueba (o real), generar link OWNER, abrirlo
   con el bot.

## 12. Riesgos/gotchas conocidos

- **Rate-limit in-memory y sesiones stateless** funcionan porque es **un solo
  proceso** (mismo supuesto de todo el sistema); si algún día hay 2 réplicas,
  revisar (documentar en ADR-010).
- **No hay "logout global" por servidor** (cookie stateless) — cubierto con la
  rotación de password; lo demás es expiración de 12h.
- **`Invitation.createdByUserId` queda `null`** para acciones del admin (no hay
  usuario); se distingue por el `action` `admin.*` en el audit.
- **El deep link no se puede regenerar** (solo hash en DB): si se pierde, se
  revoca y se crea otro — documentar en OPERACIONES.
- Windows/PowerShell: gotchas de codificación del repo (BOM, UTF-16, CRLF) al
  editar docs — verificar siempre con `git diff`.
- No tocar el modo webhook/polling existente (`TELEGRAM_WEBHOOK_URL` etc.): el
  admin no depende de él.
