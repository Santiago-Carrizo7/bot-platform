# Project Memory (bot-platform)
> Memoria episódica entre sesiones/chats/agentes. Mantener bajo **50-60 líneas**.
> Resumir o eliminar lo que ya no aporte valor. Si algo se vuelve regla permanente,
> moverlo a `AGENTS.md` (o a `CONSTITUTION.md` si es normativa). **NUNCA** secretos.

## Estado actual
- Phase 0–3 completadas con gates en verde (67 tests + smoke HTTP/DB 13/13 OK).
- Templates: `gastos` (referencia, sin instanciar en Telegram) y `kiosco`
  (12 actions, primer vertical). Repo en GitHub con push al día.
- Siguiente: Phase 4 (staging + primer trial real). Falta crear el bot del kiosco
  en BotFather (ver candidatos abajo) y poner su token en `.env`.
- Stack: Node 20+ / pnpm / TS estricto / grammY / Prisma + PG16 / Zod / Express /
  OpenRouter / Groq Whisper / vitest.
- Docs pilar: `AGENTS.md` (reglas) → `MEMORY.md` (esto) → `CONSTITUTION.md` (normas)
  → `ARCHITECTURE.md` (diseño) → `IMPLEMENTATION_PLAN.md` (fases) → `docs/adr/`.

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
- En Windows usar `pnpm.cmd`; git inicializado (commit `b16cd8f` fases 0-2).
  Falta crear el repo en GitHub y hacer push (ver pasos abajo).
- Kiosco decide (ADR-009): stock NUNCA negativo, venta sin stock se frena con
  mensaje amable; baja lógica de productos; dinero en `MoneyMovement`; sin API
  propia (bot-first); precios en moneda del negocio (sin multi-moneda en MVP).

## Próximos pasos
- [ ] Crear bot del kiosco en BotFather (candidatos: `elkiosquero_bot`,
  `lacaja_bot`, `despensa_bot`, `elmostrador_bot`) y probar polling + invitación
  + trial (Phase 4).
- [ ] Phase 4: staging + procedimiento de alta + primer trial real.
