# Project Memory (bot-platform)
> Memoria episódica entre sesiones/chats/agentes. Mantener bajo **50-60 líneas**.
> Resumir o eliminar lo que ya no aporte valor. Si algo se vuelve regla permanente,
> moverlo a `AGENTS.md` (o a `CONSTITUTION.md` si es normativa). **NUNCA** secretos.

## Estado actual
- Phase 0–3 + Sprint A + admin v1 + rediseño Kiosco en verde (140 tests + build OK).
- Webhook Render: `TELEGRAM_WEBHOOK_URL` + `SECRET` (`base64url`/`hex`, no base64 con `+/=`).
- Staging: Render free + Supabase + cron-job cada 12 min a /health. Bot: `@MiKiosquito_bot`.
- Templates: `gastos` (API en `/api/v1/gastos/*`) y `kiosco` (MVP financiero ágil:
  ventas simples/batch, ráfagas de audio, estadísticas interactivas, deshacer seguro).
- Admin web v1 implementado en `/admin` (ADR-010). Falta deploy y migración kiosco.
- Stack: Node 20+ / pnpm / TS estricto / grammY / Prisma + PG16 / Zod / Express /
  OpenRouter / Groq Whisper / vitest.
- Docs pilar: `AGENTS.md` → `MEMORY.md` → `CONSTITUTION.md` → `ARCHITECTURE.md` →
  `IMPLEMENTATION_PLAN.md` → `docs/adr/`. Operativa: `docs/OPERACIONES.md`.

## Decisiones vigentes
- Monolito modular; tenancy por `businessId`; un bot por vertical (registro estático);
  templates como módulos estáticos; IA con dispatch + Zod; confirmación en escrituras;
  trial 10 días desde 1ª escritura → `READ_ONLY`; tablas tipadas, sin `Record` genérico.
- Kiosco (ADR-011): MVP financiero ágil, cero inventario. Movimientos `MoneyMovement`.
  `interpretDirectly`: atajo 0ms para números (`3000`) y `/venta 5000`. Sin fugas de errores IA.
  Modo continuo: botones se editan in-place, se limpian en mensajes previos y deshacer multi-paso.
- Lecturas de gastos a nivel negocio; update/delete solo autor o OWNER.
- IA en cascada (`FallbackAIProvider`): Groq (Llama 3.3) -> OpenRouter -> Gemini;
  failover automático por 429, 5xx, timeout o respuesta no-JSON.
- Visión (`VisionService`): Gemini 2.0 Flash -> Groq Vision; límite 5 fotos/día por
  negocio (`countVisionByBusinessSince`), extracción libreta a `registrar_lote`.
- Madrugada comercial (00:00 a 05:00): pregunta contextual ayer vs hoy (`getEarlyMorningContext`).

## Gotchas
- `migration.sql` en UTF-8 sin BOM: PowerShell redirect `>` escribe UTF-16LE. Convertir siempre.
- Deploy Render 2026-10-06: token inválido = 404 en `deleteWebhook` y crash loop.
- DB local: Docker Desktop debe estar corriendo; `TEST_DATABASE_URL` activa test integración.
- En Windows usar `pnpm.cmd`. Repo en GitHub con push al día.
- Webhook grammY: timeout fijado a 30s con `onTimeout: 'return'`. Audio progresivo editable.
- Zod refine en inputs opcionales causa issue `custom`; `missingFields` maneja campos vacíos.

## Próximos pasos
- [ ] Push y deploy a Render (migración kiosco `20261008000000_kiosco_financial_mvp` + admin).
- [ ] Probar bot `@MiKiosquito_bot` en Telegram con nuevo flujo financiero rápido.
- [ ] Validar operación de un negocio real en staging (Phase 4).
