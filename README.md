# bot-platform

Plataforma multi-tenant para bots de Telegram verticalizados (Kiosco, Panadería,
Barbería…). Un `Core` reutilizable + productos cerrados por vertical (`templates/`).
Cada negocio es un `Business`; la diferencia entre clientes es configuración, no código.

## Documentos (leer en este orden)

1. `AGENTS.md` — reglas de trabajo para agentes (y humanos).
2. `MEMORY.md` — contexto fresco: estado, decisiones, gotchas, próximos pasos.
3. `CONSTITUTION.md` — reglas inviolables.
4. `ARCHITECTURE.md` — diseño vigente.
5. `IMPLEMENTATION_PLAN.md` — plan por fases (transitorio) + `docs/adr/`.

## Requisitos

Node.js 20+ · `pnpm` (`pnpm.cmd` en Windows) · Docker (PostgreSQL local) ·
token de Telegram (BotFather) · API key de OpenRouter · API key de Groq (STT, opcional).

## Setup (5 minutos)

```bash
docker compose up -d
cp .env.example .env   # completar tokens y API_SECRET
pnpm install
pnpm exec prisma migrate deploy
pnpm typecheck && pnpm test && pnpm build
pnpm dev
```

Con `TEST_DATABASE_URL` apuntando a otra DB se activa además el test de
aislamiento multi-tenant contra Postgres real.

## Loop de desarrollo

Local = código + tests. Ver el bot = staging (Render, auto-deploy desde `main`).

```bash
git pull
pnpm typecheck && pnpm test && pnpm build
git push   # Render redespliega solo → probar en Telegram
```

Nunca correr `pnpm dev` con el token real mientras Render está arriba (error 409:
dos pollers con el mismo token). Para dev local sin Telegram:
`TELEGRAM_POLLING=off` en `.env`. Detalle operativo en `docs/OPERACIONES.md`.

## Uso

```bash
pnpm dev      # bot + API
pnpm seed -- --name "Kiosco Don Pepe" --template gastos   # alta manual de negocio
pnpm invite -- --business <ID> --role OWNER               # invitación (deep link)
pnpm exec tsx scripts/smoke.ts                            # smoke test HTTP+DB
```

## Estructura

```
src/core/            comportamiento compartido (sin grammY/Prisma/Express)
src/infrastructure/  adaptadores: telegram, ai, stt, persistence, http
src/templates/<id>/  vertical: actions, commands, menú, prompts, domain, api
src/app/             composition root (wiring) + bootstrap
prisma/  scripts/  tests/  docs/adr/
```

## Estado

Phase 0–2 completadas (Core + template `gastos` con paridad funcional).
Siguiente: Phase 3 (`templates/kiosco/`). Ver `MEMORY.md` y `IMPLEMENTATION_PLAN.md`.
