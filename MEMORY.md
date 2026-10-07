# Project Memory (bot-platform)
> Memoria episódica entre sesiones/chats/agentes. Mantener bajo **50-60 líneas**.
> Resumir o eliminar lo que ya no aporte valor. Si algo se vuelve regla permanente,
> moverlo a `AGENTS.md` (o a `CONSTITUTION.md` si es normativa). **NUNCA** secretos.

## Estado actual
- Phase 0–3 + Sprint A + webhook en verde (116 tests + smoke OK). Webhook en modo
  activo en Render (`TELEGRAM_WEBHOOK_URL` + `SECRET` seteados; el secret debe ser
  `base64url`/`hex`, NO base64 con `+/=` → 400 illegal characters). Falta verificar
  en logs `Webhook registrado para 'kiosco'` y probar el bot.
- Staging: Render free + Supabase + cron-job cada 12 min a /health (no duerme).
  Bot kiosco: `@MiKiosquito_bot` (token válido, verificado).
- Templates: `gastos` (API en `/api/v1/gastos/*`) y `kiosco` (12 actions, barra
  persistente, `/invitar`, onboarding sin productos).
- Testing = día a día en staging (continuo, no es fase). Siguiente: Sprint C
  (foto/Excel). **Item D (admin web) implementado**: `/admin` en el mismo Express
  (plan `docs/PLAN-ADMIN-WEB-V1.md` ejecutado en 5 slices, ADR-010). Falta deploy.
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
- DB local: Docker Desktop debe estar corriendo (`docker compose up -d`);
  `TEST_DATABASE_URL` activa el test de integración (sin ella se saltea; P1001 =
  daemon caído). **2026-10-07: el servicio Windows `postgresql-x64-18` se lleva
  5432 → P1000 en `localhost:5432`; workaround: contenedor descartable
  `bot-platform-pg-test` en 5433 o parar ese servicio con admin.**
- Generar diffs incrementales con `migrate diff --from-migrations` (+ lock file y
  `--shadow-database-url`); el diff `--from-empty` sirve solo para la inicial.
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
- [ ] Push de fix `df982b8` (validación de charset del secret) → verificar webhook
  en logs y probar bot (checks: OPERACIONES §7).
- [ ] **Deploy del admin**: Render → Environment → `ADMIN_PASSWORD` (≥16 chars) →
  push → entrar a `https://<app>/admin/` → crear un negocio, generar link OWNER,
  abrirlo con el bot. Operación: `OPERACIONES.md` §10.
- [ ] Sprint C: carga masiva (foto de carta → `cargar_productos_desde_foto`, luego
  Excel).
