# Project Memory (bot-platform)
> Memoria episódica entre sesiones/chats/agentes. Mantener bajo **50-60 líneas**.
> Resumir o eliminar lo que ya no aporte valor. Si algo se vuelve regla permanente,
> moverlo a `AGENTS.md` (o a `CONSTITUTION.md` si es normativa). **NUNCA** secretos.

## Estado actual
- Phase 0, 1 y 2 completadas con gates en verde (55 tests + smoke HTTP/DB 13/13 OK).
- Siguiente: Phase 3 (template kiosco). Telegram real (polling) aún no probado.
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
- `migration.sql` SIN BOM: `Set-Content -Encoding UTF8` mete BOM y Prisma falla (P3009).
- Docker Desktop debe estar corriendo para la DB local; `TEST_DATABASE_URL` activa el
  test de integración (sin ella se saltea).
- `.env` local tiene tokens fake (sirve para smoke/API; para Telegram real hay que
  poner tokens de BotFather). No commitear `.env`.
- En Windows usar `pnpm.cmd`; repo aún sin git (pendiente init + GitHub).

## Próximos pasos
- [ ] Phase 3: `templates/kiosco/` (products, sales, stock, purchases, summaries).
- [ ] Conseguir token real de Telegram y probar polling + invitación + trial.
- [ ] `git init`, commit inicial y subida a GitHub (para trabajo multi-agente).
