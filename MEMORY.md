# Project Memory (bot-platform)
> Memoria episódica entre sesiones/chats/agentes. Mantener bajo **50-60 líneas**.
> Resumir o eliminar lo que ya no aporte valor. Si algo se vuelve regla permanente,
> moverlo a `AGENTS.md` (o a `CONSTITUTION.md` si es normativa). **NUNCA** secretos.

## Estado actual
- Phase 0–3 + Sprint A en verde (81 tests + smoke 13/13 OK). Tanda A commiteada,
  falta `git push` para que Render la tome.
- Staging: Render free + Supabase + cron-job cada 12 min a /health (no duerme).
  Bot kiosco creado en BotFather. Incidente "bot muerto": sleep descartado por el
  pinger; verificar env/logs/409 según `docs/OPERACIONES.md` §6.
- Templates: `gastos` (API en `/api/v1/gastos/*`) y `kiosco` (12 actions, barra
  persistente, `/invitar`, onboarding sin productos).
- Testing = día a día en staging (continuo, no es fase). Siguiente: Sprint C
  (foto/Excel) y después Item D (mini dashboard en el Express de Render + ADR).
- Stack: Node 20+ / pnpm / TS estricto / grammY / Prisma + PG16 / Zod / Express /
  OpenRouter / Groq Whisper / vitest.
- Docs pilar: `AGENTS.md` → `MEMORY.md` (esto) → `CONSTITUTION.md` →
  `ARCHITECTURE.md` → `IMPLEMENTATION_PLAN.md` → `docs/adr/`. Operativa diaria:
  `docs/OPERACIONES.md`.

## Decisiones vigentes
- Monolito modular; tenancy por `businessId`; un bot por vertical (registro estático);
  templates como módulos estáticos; IA con dispatch + Zod; confirmación en escrituras;
  trial 10 días desde 1ª escritura → `READ_ONLY`; tablas tipadas, sin `Record` genérico.
- Lecturas de gastos a nivel negocio; update/delete solo autor o OWNER.

## Gotchas
- `migration.sql` en UTF-8 sin BOM: `Set-Content -Encoding UTF8` mete BOM (P3009) y
  el redirect `>` de PowerShell escribe UTF-16LE (Prisma P3015). Convertir siempre.
- Deploy Render 2026-10-06: token de Telegram inválido = 404 de la API en
  `deleteWebhook` y crash loop. Ahora los tokens son opcionales y se validan con
  `getMe()` al arrancar (mensaje claro). Si falla el deploy, mirar ese log primero.
- Docker Desktop no siempre está corriendo: si el test de integración da P1001,
  levantar el daemon + `docker compose up -d` y reintentar.
- Generar diffs incrementales con `migrate diff --from-migrations` (+ lock file y
  `--shadow-database-url`); el diff `--from-empty` sirve solo para la inicial.
- Docker Desktop debe estar corriendo para la DB local; `TEST_DATABASE_URL` activa el
  test de integración (sin ella se saltea).
- `.env` local tiene tokens fake (sirve para smoke/API; para Telegram real hay que
  poner tokens de BotFather). No commitear `.env`.
- En Windows usar `pnpm.cmd`. Repo en GitHub con push al día.
- `Set-Content -Value $array -NoNewline` colapsa el archivo en 1 línea (el
  newline se omite por elemento): para reescrituras usar
  `[System.IO.File]::WriteAllLines()`. Y verificar siempre con `git diff`.
- Kiosco decide (ADR-009): stock NUNCA negativo, venta sin stock se frena con
  mensaje amable; baja lógica de productos; dinero en `MoneyMovement`; sin API
  propia (bot-first); precios en moneda del negocio (sin multi-moneda en MVP).

## Próximos pasos
- [ ] `git push` (tanda A + webhook) → en Render agregar `TELEGRAM_WEBHOOK_URL` +
  `TELEGRAM_WEBHOOK_SECRET` → verificar: logs `Webhook registrado`, barra
  persistente, /menu completo, /invitar, onboarding (checks: OPERACIONES §7).
- [ ] Sprint C: carga masiva (foto de carta → `cargar_productos_desde_foto`, luego
  Excel). Después Item D: mini dashboard (`/admin` en Render + ADR de alcance).
