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
- [ ] Scaffold: `package.json` (pnpm), `tsconfig`, `.env.example`, `Dockerfile`,
  `docker-compose.yml`, `.gitignore`, CI mínima (`typecheck/test/build`).
- [ ] Prisma: schema core + migración inicial (validada con `prisma migrate diff`;
  aplicada contra DB local cuando haya motor disponible).
- [ ] Tests: vitest configurado; estructura `tests/` con fakes en memoria.

## Phase 1 — Core extraction

Objetivo: base que compila, testea y resuelve tenant sin dominio de negocio.

- [ ] `TenantContext` (bot → usuario Telegram → membership → business) + resolver.
- [ ] `Business` (+ `status`: `TRIAL|ACTIVE|READ_ONLY|SUSPENDED`; trial 10 días desde
  primera acción real de negocio; gracia configurable; expiración → `READ_ONLY`).
- [ ] `User` (por `telegramId`) + `Membership` + roles `OWNER|EMPLOYEE` (+ helper
  `requireRole`, owner-only para invitaciones/revocación/auditoría).
- [ ] Invitaciones: crear (token aleatorio, hash, expiración, 1 uso, rol), consumir
  vía `/start <TOKEN>` (deep link), revocar, auditar. Script manual `scripts/`.
- [ ] Telegram runtime compartido: contexto, middleware identidad+membership,
  comandos base (`/start`, `/ayuda`, `/cancelar`), error boundary, rate limit,
  descarga de audio, teclados inline.
- [ ] IA: `IAIProvider` + OpenRouter + intérprete genérico (`{action, params}`,
  whitelist, Zod, 1 reintento). STT: contrato + provider OpenAI-compatible + servicio.
- [ ] `Action Registry` base (tipos `Action`/`Command`, registro por template).
- [ ] Conversación multi-mensaje: `ConversationState` con TTL, slot-filling por
  campos faltantes (guiado por errores Zod + prompts del template), `/cancelar`.
- [ ] Confirmación: toda `Action` de escritura pasa por Sí/No antes de ejecutar.
- [ ] Auditoría: `AuditLog` + helper de Core; actor obligatorio en mutaciones.
- [ ] API base: Express app, auth HMAC (`API_SECRET`, expiración, `businessId`
  firmado), error handler, `/health`. Sin rutas de dominio aún.
- [ ] Tests: tenant isolation, invitaciones (válida/expirada/usada/revocada),
  roles, trial (inicio en 1ª escritura; lecturas no lo inician), `READ_ONLY`
  bloquea escrituras, confirmación obligatoria, dispatch, interpretación con mock.
- **Gate:** gates en verde + bot responde `/start`/`/ayuda` resolviendo tenant.

## Phase 2 — Gastos template (referencia)

Objetivo: paridad funcional con `bot-gastos` sobre el nuevo Core.

- [ ] `templates/gastos/`: actions (`registrar_gasto` con confirmación; lecturas:
  últimos, total, resumen), commands (`/gastos`, `/total`, `/presupuesto`,
  `/categorias`, `/vincular` con token HMAC), menú, prompts, seeds de categorías.
- [ ] Dominio + persistencia portados con `businessId` (`Expense`, `Category`,
  `Budget` por usuario dentro del negocio); repos sin `prisma` crudo expuesto.
- [ ] API de gastos (si aporta a la arquitectura; con auth HMAC + scope por negocio).
- [ ] Tests existentes adaptados (parser, whitelist, STT, formatters) + tenant
  isolation del template.
- **Gate obligatorio:** `Functional parity with bot-gastos` (texto, audio, IA,
  registro, consultas, API si se incluyó, tests en verde).

## Phase 3 — Kiosco (primer vertical comercial)

- [ ] Tablas: `Product`, `Sale` (+líneas), `Purchase`, `MoneyMovement`,
  `StockMovement`. `businessId` en todas.
- [ ] Actions: productos (CRUD + stock inicial), stock (consultar/ajustar/movimientos),
  ventas (multi-producto, cantidades, total, descuento de stock), compras/gastos,
  consultas (día/mes/histórico/stock; evaluar "stock bajo" solo si encaja).
- [ ] Menú + freestyle + audio + confirmación, convergiendo en las mismas actions.
- [ ] Seeds mínimas por negocio (categorías/unidades base si hacen falta).
- [ ] Tests del template (incl. descuento de stock y confirmación).
- **Gate:** flujo kiosco extremo a extremo en staging con datos de prueba.

## Phase 4 — First real client validation

- [ ] Procedimiento documentado: alta de negocio → invitación → vincular dueño →
  vincular empleados → configurar (productos/stock) → trial activo → operar →
  pasar a `ACTIVE` / `READ_ONLY` → auditar.
- [ ] Staging + hosting definido; logs con `businessId`; recordatorios de gracia.
- **Gate:** un negocio real opera una semana sin intervención de desarrollo.

## Phase 5 — Only after real usage

Recién con uso real evaluar: panel administrativo, configuración self-service,
mejoras de roles, nuevas abstracciones Core, segundo vertical. Nada de esto se
diseña ni se implementa antes.

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
