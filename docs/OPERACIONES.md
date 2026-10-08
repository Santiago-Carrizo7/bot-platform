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

Camino rápido: **admin web** (`/admin`, ver §10). El CLI de abajo sigue sirviendo
para automatizar o cuando no hay web.

Apuntar temporalmente a Supabase y volver a local después:

```powershell
# 1. Conseguir el ID numérico de Telegram con @userinfobot
# 2. En .env, reemplazar DATABASE_URL por la URI de Supabase (formato Prisma)
pnpm seed -- --name "Kiosco Don Pepe" --template kiosco --owner-telegram-id <ID>
# O para rotisería: pnpm seed -- --name "Rotisería Los Amigos" --template rotiseria --owner-telegram-id <ID>
# 3. Devolver DATABASE_URL a local
```

El dueño busca `@<bot>` en Telegram → `/start` → listo, sin invitación.

## 4. Invitar gente

- **Desde el bot** (dueño): `/invitar` → link de empleado (7 días, 1 uso).
  `/invitar dueno` → link de dueño (para socios).
- **Admin web** (§10): detalle del negocio → rol + días → "Crear link"; también
  muestra el estado de cada invitación y permite revocar.
- **Por terminal** (cualquier rol, contra la DB que apunte tu `.env`):
  `pnpm invite -- --business <BUSINESS_ID> --role OWNER|EMPLOYEE`
- El invitado abre el link → queda vinculado al tocar `/start`.

## 5. Webhook vs polling

- **Modo webhook** (recomendado en Render): con `TELEGRAM_WEBHOOK_URL` seteada
  (ej. `https://mi-app.onrender.com`), Telegram empuja cada mensaje al servidor
  (`POST /telegram/<templateId>`, validado con el secret). Sin pinger, sin 409,
  instantáneo. Requiere además `TELEGRAM_WEBHOOK_SECRET` (mínimo 16 caracteres,
  generar con `openssl rand -base64 24`).
- **Modo polling** (sin URL): el servidor pregunta a Telegram cada ~1 s. Sirve
  para desarrollo local; en Render necesita el cron-job para no dormirse.
- **Nunca mezclar**: mientras haya un webhook activo, un `pnpm dev` local con el
  token real falla (Telegram rechaza el polling). Para volver a polling local:
  `pnpm webhook -- --template kiosco --delete` (con el `.env` que tenga el token
  real). Para ver el estado: `pnpm webhook -- --template kiosco`.
- Al prender el servidor en modo webhook se registra solo (`setWebhook`); al
  redeployar se re-registra sin perder mensajes (Telegram reintenta la entrega).
- Si el log dice `secret token contains illegal characters`: el secret tiene
  caracteres fuera de `[A-Za-z0-9_-]` → regenerar con `openssl rand -hex 24`.

## 6. Env vars de Render (dashboard → Environment)

`NODE_ENV=production` · `API_SECRET` (generar con `openssl rand -base64 32`) ·
`DATABASE_URL` (Supabase, formato Prisma) · `TELEGRAM_BOT_TOKEN_KIOSCO` ·
`OPENROUTER_API_KEY` + `OPENROUTER_MODEL=google/gemini-2.0-flash-001` ·
`STT_PROVIDER=groq` + `STT_API_KEY` (+ `STT_MODEL=whisper-large-v3-turbo`) ·
`TRIAL_DAYS=10` · `GRACE_DAYS=7`. (Render inyecta `PORT` solo; no pisarlo.)
`ADMIN_PASSWORD` (mínimo 16 caracteres) solo si se quiere el admin web `/admin`
(sin ella la ruta responde 404; ver §10).
`TELEGRAM_BOT_TOKEN_GASTOS` y `TELEGRAM_BOT_TOKEN_ROTISERIA` cuando se instancien esos verticales.
Webhook: `TELEGRAM_WEBHOOK_URL=https://<app>.onrender.com` +
`TELEGRAM_WEBHOOK_SECRET` (generar con `openssl rand -hex 24`; Telegram solo
acepta letras, números, `_` y `-`, así que NO usar base64 común).

## 7. El bot no responde (checklist en orden)

1. **¿Render dormido?** (Solo en modo polling.) Abrir `/health` en el navegador,
   esperar 15 s, reintentar. Si revive → revisar cron-job (¿sigue activo cada
   12 min?). En modo webhook cada mensaje despierta solo al servidor.
2. **¿Crash loop?** Logs de Render: si no aparece `Token válido para 'kiosco'`,
   el deploy no levantó (token inválido/mal copiado o `TELEGRAM_BOT_TOKEN_GASTOS`
   seteado con valor malo → sacarlo).
3. **¿409?** Buscar `409` en los logs: otro proceso está polleando con el mismo
   token (un `pnpm dev` local olvidado). Matarlo.
4. **¿404 de Telegram?** Token que no existe (mal tipeado o bot eliminado en
   BotFather). Regenerar y actualizar la env var.

## 8. BotFather (5 min, por bot)

`/setuserpic` (avatar) · `/setdescription` (se ve al compartir el contacto) ·
`/setabouttext` (ficha del bot). El menú lateral de comandos lo sube el bot solo
(`menuCommands` del template); no configurarlo a mano. Mini Apps: no (fuera de
alcance, ver `ARCHITECTURE.md` §18).

## 9. API HTTP (convención congelada)

- `GET /health` → pública (liveness).
- `/api/*` → `Authorization: Bearer <token HMAC>` (firmado: userId + businessId
  + expiración; ver `src/infrastructure/http/api-tokens.ts`).
- `/api/me` → identidad general (core).
- `/api/v1/<templateId>/*` → router de cada template (ej. `/api/v1/gastos/expenses`).
- Respuestas: `{ data }` ok · `{ error, message }` error.
- El bot NO usa esta API (habla directo a la DB en el mismo proceso); es para
  integraciones y debug (el admin web tampoco: va por sesiones, ver §10).

## 10. Admin web (`/admin`) — operaciones del día a día

Herramienta interna de ops (misma app, cero infra nueva; ver
`docs/adr/ADR-010-admin-web-interna.md`). Requiere `ADMIN_PASSWORD` (mínimo 16
caracteres): **sin esa variable `/admin` responde 404**.

- **Entrar:** `https://<app>/admin/` → password → sesión de 12 h (cookie
  `HttpOnly; SameSite=Strict; Path=/admin`). Sin "usuarios": hay una sola password
  compartida, guardada solo en el env.
- **Crear negocio:** lista → "Crear negocio" (nombre, template, timezone/moneda con
  defaults) → corre los seeds del template y te lleva al detalle.
- **Generar link:** detalle → rol `OWNER|EMPLOYEE` + días (1-90) → "Crear link".
  El deep link se muestra **una sola vez** (la DB guarda solo el hash): copiarlo ahí
  mismo. Si se pierde: **revocar y crear otro** (no se puede regenerar).
- **Revocar:** botón en la tabla de invitaciones (aparece en pendientes/expiradas;
  las usadas/revocadas quedan para el historial).
- **Cambiar estado** (`TRIAL|ACTIVE|READ_ONLY|SUSPENDED`): en el detalle, para
  suspender a un vivo o desbloquear un trial vencido. No lo cambia nadie más.
- **Miembros:** telegramId + rol de los vinculados (sin datos sensibles).
- **Auditoría:** toda mutación queda en `AuditLog` con acción `admin.*` y
  `actorUserId: null` (no hay usuario; viaja la password).
- **Rotar la password:** cambiar `ADMIN_PASSWORD` en Render → Environment →
  redeploy. Mata **todas** las sesiones abiertas (la cookie lleva un fingerprint de
  la password vigente). No hay "logout global" por servidor: rotar es el cierre.
- **Si perdés la password:** no hay recuperación (no hay usuarios en DB ni email).
  Setear un valor nuevo en Render → redeploy. Igual conviene rotarla si alguien
  más pudo verla.
- **Rate limit:** 5 fallos de login cada 10 min por IP → 429 (en memoria, un solo
  proceso). Si te bloqueás: esperar 10 min o redeployar.
- **Local:** `.env` con `ADMIN_PASSWORD` → `pnpm dev` →
  `http://localhost:3000/admin/`. Funciona con `TELEGRAM_POLLING=off`; para crear
  links hace falta un bot real configurado para ese template (si no, error
  amigable indicando cuál `TELEGRAM_BOT_TOKEN_<VERTICAL>` falta).
- **No es el producto:** no hay métricas, edición de datos, multi-admin ni
  reset de trial (v2+, ver ADR-010).
