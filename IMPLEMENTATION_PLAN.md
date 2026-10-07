# IMPLEMENTATION_PLAN.md — bot-platform

> Documento **transitorio**: vive hasta Phase 5. Al estabilizar la plataforma se
> archiva (p. ej. `docs/archive/`) y el trabajo pasa a issues. No agregar acá
> secciones permanentes: el diseño duradero va en `ARCHITECTURE.md` y los
> porqués en `docs/adr/`.

Plan ejecutable. Secuencia obligatoria: extraer Core mínimo → gastos vuelve a
funcionar → construir kiosco → el segundo template valida el diseño.
**Quality gates al cerrar cada fase:** `pnpm typecheck` + `pnpm test` + `pnpm build`
en verde. Si un gate falla, se corrige antes de avanzar.

## Phase 0 — Foundation / decisions ✅ (completada al crear este plan)

- [x] `CONSTITUTION.md`, `AGENTS.md`, `ARCHITECTURE.md`, este plan.
- [x] ADRs iniciales en `docs/adr/` (monolito, tenancy, bot por vertical, tablas
  tipadas, registro estático, dispatch vs tools, confirmación, trial).
- [x] `ARQUITECTURA.md` marcado como superseded (referencia histórica).
- [x] Scaffold: `package.json` (pnpm), `tsconfig`, `.env.example`, `Dockerfile`,
  `docker-compose.yml`, `.gitignore`, CI mínima (`typecheck/test/build`).
- [x] Prisma: schema core + migración inicial (validada con `prisma migrate diff`;
  aplicada contra DB local cuando haya motor disponible).
- [x] Tests: vitest configurado; estructura `tests/` con fakes en memoria.

## Phase 1 — Core extraction

Objetivo: base que compila, testea y resuelve tenant sin dominio de negocio.

- [x] `TenantContext` (bot → usuario Telegram → membership → business) + resolver.
- [x] `Business` (+ `status`: `TRIAL|ACTIVE|READ_ONLY|SUSPENDED`; trial 10 días desde
  primera acción real de negocio; gracia configurable; expiración → `READ_ONLY`).
- [x] `User` (por `telegramId`) + `Membership` + roles `OWNER|EMPLOYEE` (+ helper
  `requireRole`, owner-only para invitaciones/revocación/auditoría).
- [x] Invitaciones: crear (token aleatorio, hash, expiración, 1 uso, rol), consumir
  vía `/start <TOKEN>` (deep link), revocar, auditar. Script manual `scripts/`.
- [x] Telegram runtime compartido: contexto, middleware identidad+membership,
  comandos base (`/start`, `/ayuda`, `/cancelar`), error boundary, rate limit,
  descarga de audio, teclados inline.
- [x] IA: `IAIProvider` + OpenRouter + intérprete genérico (`{action, params}`,
  whitelist, Zod, 1 reintento). STT: contrato + provider OpenAI-compatible + servicio.
- [x] `Action Registry` base (tipos `Action`/`Command`, registro por template).
- [x] Conversación multi-mensaje: `ConversationState` con TTL, slot-filling por
  campos faltantes (guiado por errores Zod + prompts del template), `/cancelar`.
- [x] Confirmación: toda `Action` de escritura pasa por Sí/No antes de ejecutar.
- [x] Auditoría: `AuditLog` + helper de Core; actor obligatorio en mutaciones.
- [x] API base: Express app, auth HMAC (`API_SECRET`, expiración, `businessId`
  firmado), error handler, `/health`. Sin rutas de dominio aún.
- [x] Tests: tenant isolation, invitaciones (válida/expirada/usada/revocada),
  roles, trial (inicio en 1ª escritura; lecturas no lo inician), `READ_ONLY`
  bloquea escrituras, confirmación obligatoria, dispatch, interpretación con mock.
- **Gate:** gates en verde + bot responde `/start`/`/ayuda` resolviendo tenant.

## Phase 2 — Gastos template (referencia)

Objetivo: paridad funcional con `bot-gastos` sobre el nuevo Core.

- [x] `templates/gastos/`: actions (`registrar_gasto` con confirmación; lecturas:
  últimos, total, resumen), commands (`/gastos`, `/total`, `/presupuesto`,
  `/categorias`, `/vincular` con token HMAC), menú, prompts, seeds de categorías.
- [x] Dominio + persistencia portados con `businessId` (`Expense`, `Category`,
  `Budget` por usuario dentro del negocio); repos sin `prisma` crudo expuesto.
- [x] API de gastos (si aporta a la arquitectura; con auth HMAC + scope por negocio).
- [x] Tests existentes adaptados (parser, whitelist, STT, formatters) + tenant
  isolation del template.
- **Gate obligatorio:** `Functional parity with bot-gastos` (texto, audio, IA,
  registro, consultas, API si se incluyó, tests en verde).

## Phase 3 — Kiosco (primer vertical comercial) ✅ (primera pasada completa)

- [x] Tablas: `Product`, `Sale` (+`SaleItem`), `Purchase`, `MoneyMovement`,
  `StockMovement`. `businessId` en todas (migración aplicada en dev y test).
- [x] Actions (12): productos (crear/modificar/eliminar + stock inicial),
  stock (consultar, stock bajo, fijar), ventas (multi-producto, cantidades,
  total calculado, descuento de stock), compras (con entrada opcional a stock),
  gastos, entradas, caja del día, resumen del mes, historial de ventas.
- [x] Menú + freestyle + audio + confirmación, convergiendo en las mismas actions.
  Sin seeds globales (cada kiosco carga sus productos); sin API propia (bot-first).
- [x] Tests del template (12: total/descuento/movimientos, producto faltante,
  stock negativo con aviso, compra con stock, fijar stock, stock bajo,
  resumen día, flujo freestyle→confirmación→auditoría).
- [x] Gates en verde: `typecheck` ✓, `test` ✓ (67 tests), `build` ✓.
- Decisiones tomadas: el stock NUNCA queda negativo (la venta se frena con mensaje
  amable que dice qué falta y cómo arreglarlo — ver ADR-009); baja de producto
  lógica (conserva historial); compras/gastos/entradas en `MoneyMovement`
  (`IN`/`OUT`); ventas/compras/gastos/entradas generan movimientos de caja
  automáticamente; hints del prompt con catálogo real (nombre/precio/stock);
  precios en moneda del negocio (sin multi-moneda en el MVP).
- **Gate pendiente:** flujo extremo a extremo en staging con datos reales
  (requiere token de Telegram) → Phase 4.

## Phase 4 — First real client validation

- [ ] Procedimiento documentado: alta de negocio → invitación → vincular dueño →
  vincular empleados → configurar (productos/stock) → trial activo → operar →
  pasar a `ACTIVE` / `READ_ONLY` → auditar.
- [ ] Staging + hosting definido; logs con `businessId`; recordatorios de gracia.
- **Gate:** un negocio real opera una semana sin intervención de desarrollo.

## Phase 5 — Only after real usage

Recién con uso real evaluar: panel administrativo, configuración self-service,
mejoras de roles, nuevas abstracciones Core, segundo vertical. Nada de esto se
diseña ni se implementa antes. **Excepción ya ejecutada:** el admin interno
mínimo `/admin` (ops del día a día, `docs/PLAN-ADMIN-WEB-V1.md` + ADR-010); el
resto sigue fuera de alcance.

---

## Registro de avance

- 2026-10-06: Phase 0 completada (documentos + ADRs + scaffold + schema + migración
  aplicada en `bot_platform` y `bot_platform_test` + CI mínima).
- 2026-10-06: Phase 1 completada. Gates en verde: `typecheck` ✓, `test` ✓
  (47 unitarios + 1 integración Postgres real de tenant isolation), `build` ✓.
  Core: TenantContext/resolver, Business+status/trial, User/Membership/roles,
  invitaciones (token/hash/expiración/1 uso/revocación/auditoría), Telegram runtime
  (identidad, rate limit, voz→STT, callbacks, menú), intérprete IA genérico,
  Action Registry, conversación multi-mensaje + `/cancelar`, confirmación en
  escrituras, auditoría, API base con auth HMAC, script manual de invitaciones.
- 2026-10-06: Phase 2 completada. Gates en verde: `typecheck` ✓, `test` ✓
  (55 tests incl. integración real), `build` ✓ + smoke test HTTP/DB (13 checks OK).
  Template gastos: 9 actions (registrar/consultar/total/resumen/presupuestos/fijar/
  categorías/vincular/eliminar), 6 comandos, menú inline, prompts con hints por
  negocio, API completa con scope por negocio, seeds, scripts seed/smoke.
  Paridad funcional con bot-gastos verificada (texto/voz vía pipeline, IA,
  registro, consultas, presupuestos, categorías, vincular con token HMAC).
- 2026-10-06: staging en Render + Supabase (plan free + cron-job cada 12 min
  contra /health para que no duerma). Tokens de bot opcionales + validación con
  getMe() al arrancar (un token inválido ya no mata el deploy con un 404
  críptico). Checkboxes de fases 0-2 marcados (estaban completadas).
- 2026-10-06: Sprint A (bot intuitivo). Teclado persistente en Core
  (`TemplateDefinition.replyMenu`, match exacto sin IA, gana el inline en
  confirmaciones) + barra del kiosco (Vender/Stock/Entró mercadería/Caja).
  Menú inline completo con las 12 actions en criollo + comandos
  (compra/ajustar/gasto/entrada) + `setMyCommands` con lo del negocio primero.
  `/invitar` desde el bot (OWNER; empleado por defecto, `/invitar dueno` para
  dueño). `welcomeHint` en /start//menu//ayuda (kiosco guía el alta si no hay
  productos). `TELEGRAM_POLLING=off` para dev local sin Telegram.
  API namespaced: `/api/v1/<templateId>/*` (`/api/me` y `/health` quedan);
  smoke actualizado. Convención documentada en `server.ts` + `docs/OPERACIONES.md`.
  Gates en verde (81 tests).
- 2026-10-06: modo webhook (a pedido). Con `TELEGRAM_WEBHOOK_URL` Telegram empuja
  updates a `POST /telegram/<templateId>` (validado con secret); sin URL sigue el
  long polling. `setWebhook` se registra solo al arrancar; script
  `pnpm webhook -- --template <id> [--delete]` para ver/borrar. Refino de config:
  URL sin secret falla con mensaje claro. Gates en verde (85 tests + smoke OK).
- 2026-10-07: **Item D / admin web v1** (`/admin`, plan `docs/PLAN-ADMIN-WEB-V1.md`
  en 5 slices, ADR-010). Cookie HMAC de 12 h con `ADMIN_PASSWORD` (sin ella → 404),
  rate limit de login, guard de origen, lista/alta de negocios con seeds, detalle
  con miembros, invitaciones (deep link único, revocación) y cambio de estado, todo
  auditado con `admin.*`. Docs (`OPERACIONES` §10, `README`, `ARCHITECTURE` §18) y
  smoke actualizado. Gates en verde (116 tests + smoke OK).
