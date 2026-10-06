# Operaciones (staging + día a día)

Guía copy-pasteable para operar la plataforma sin adivinar. Reglas permanentes
viven en `AGENTS.md`; esto es procedimiento.

## 1. Arquitectura del deploy

- **Render** (plan free): corre la app (bots por polling + API HTTP). Auto-deploy
  desde `main` de GitHub.
- **Supabase**: Postgres único (todos los negocios y templates, separados por
  `businessId`).
- **cron-job.org**: pega a `https://<app>.onrender.com/health` cada 12 min para
  que Render free no se duerma (duerme a los ~15 min sin tráfico HTTP *entrante*;
  el polling de Telegram es saliente y NO lo mantiene vivo).
- **Regla de oro**: local = código + tests. Ver el bot = staging. **Nunca** correr
  `pnpm dev` local con el token real mientras Render está arriba (dos pollers con
  el mismo token → error 409 de Telegram y uno queda mudo).

## 2. Desarrollo local

```powershell
pnpm install
docker compose up -d
pnpm exec prisma migrate deploy
pnpm typecheck; $env:TEST_DATABASE_URL="postgresql://postgres:postgrespassword@localhost:5432/bot_platform_test?schema=public"; pnpm test; pnpm build
```

- `TELEGRAM_POLLING=off` en `.env` → levanta solo HTTP/API sin Telegram (sirve
  con tokens fake para probar la API).
- Si el test de integración falla con P1001: Docker Desktop apagado → prenderlo y
  `docker compose up -d`.

## 3. Alta de un negocio (primera vez, por terminal)

Apuntar temporalmente a Supabase y volver a local después:

```powershell
# 1. Conseguir el ID numérico de Telegram con @userinfobot
# 2. En .env, reemplazar DATABASE_URL por la URI de Supabase (formato Prisma)
pnpm seed -- --name "Kiosco Don Pepe" --template kiosco --owner-telegram-id <ID>
# 3. Devolver DATABASE_URL a local
```

El dueño busca `@<bot>` en Telegram → `/start` → listo, sin invitación.

## 4. Invitar gente

- **Desde el bot** (dueño): `/invitar` → link de empleado (7 días, 1 uso).
  `/invitar dueno` → link de dueño (para socios).
- **Por terminal** (cualquier rol, contra la DB que apunte tu `.env`):
  `pnpm invite -- --business <BUSINESS_ID> --role OWNER|EMPLOYEE`
- El invitado abre el link → queda vinculado al tocar `/start`.

## 5. Env vars de Render (dashboard → Environment)

`NODE_ENV=production` · `API_SECRET` (generar con `openssl rand -base64 32`) ·
`DATABASE_URL` (Supabase, formato Prisma) · `TELEGRAM_BOT_TOKEN_KIOSCO` ·
`OPENROUTER_API_KEY` + `OPENROUTER_MODEL=google/gemini-2.0-flash-001` ·
`STT_PROVIDER=groq` + `STT_API_KEY` (+ `STT_MODEL=whisper-large-v3-turbo`) ·
`TRIAL_DAYS=10` · `GRACE_DAYS=7`. (Render inyecta `PORT` solo; no pisarlo.)
`TELEGRAM_BOT_TOKEN_GASTOS` solo cuando se instancie ese vertical.

## 6. El bot no responde (checklist en orden)

1. **¿Render dormido?** Abrir `/health` en el navegador, esperar 15 s, reintentar.
   Si revive → revisar cron-job (¿sigue activo cada 12 min?).
2. **¿Crash loop?** Logs de Render: si no aparece `Token válido para 'kiosco'`,
   el deploy no levantó (token inválido/mal copiado o `TELEGRAM_BOT_TOKEN_GASTOS`
   seteado con valor malo → sacarlo).
3. **¿409?** Buscar `409` en los logs: otro proceso está polleando con el mismo
   token (un `pnpm dev` local olvidado). Matarlo.
4. **¿404 de Telegram?** Token que no existe (mal tipeado o bot eliminado en
   BotFather). Regenerar y actualizar la env var.

## 7. BotFather (5 min, por bot)

`/setuserpic` (avatar) · `/setdescription` (se ve al compartir el contacto) ·
`/setabouttext` (ficha del bot). El menú lateral de comandos lo sube el bot solo
(`menuCommands` del template); no configurarlo a mano. Mini Apps: no (fuera de
alcance, ver `ARCHITECTURE.md` §18).

## 8. API HTTP (convención congelada)

- `GET /health` → pública (liveness).
- `/api/*` → `Authorization: Bearer <token HMAC>` (firmado: userId + businessId
  + expiración; ver `src/infrastructure/http/api-tokens.ts`).
- `/api/me` → identidad general (core).
- `/api/v1/<templateId>/*` → router de cada template (ej. `/api/v1/gastos/expenses`).
- Respuestas: `{ data }` ok · `{ error, message }` error.
- El bot NO usa esta API (habla directo a la DB en el mismo proceso); es para el
  futuro dashboard, integraciones y debug.
