# Project Memory (bot-platform)
> Memoria episódica entre sesiones/chats/agentes. Mantener bajo **50-60 líneas**.
> Resumir o eliminar lo que ya no aporte valor. Si algo se vuelve regla permanente,
> moverlo a `AGENTS.md` (o a `CONSTITUTION.md` si es normativa). **NUNCA** secretos.

## Estado actual
- Phase 0–3 + Sprint A + webhook en verde. Webhook en modo activo en Render.
- Staging: Render free + Supabase + cron-job cada 12 min a /health (no duerme).

- Quality gates al 100%: `pnpm typecheck` OK, `pnpm test` OK, `pnpm build` OK.
- Stack: Node 20+ / pnpm / TS estricto / grammY / Prisma + PG16 / Zod / Express / vitest.

## Decisiones vigentes
- Monolito modular; tenancy por `businessId`; un bot por vertical (registro estático);
  templates como módulos estáticos; IA con dispatch + Zod; confirmación en escrituras;
  trial 10 días desde 1ª escritura → `READ_ONLY`; tablas tipadas, sin `Record` genérico.
- `ActionDef.skipConfirmation`: escrituras directas (ventas Kiosco) inician trial y respetan `READ_ONLY`.
- Rotisería repositorio: `deactivateProduct`, `deactivatePromo`, `updateZone` y `deactivate` validadas por `businessId`.
- TenantResolver: invitaciones validan coincidencia estricta de `templateId` con el bot receptor.
- IA/Visión: timeout estricto de 20s en llamadas HTTP externas; Express con `trust proxy 1` y `helmet`.

## Gotchas
- Telegram Markdown V1 rompe con `_` en URLs: enlaces deep link deben enviarse sin `parseMode: 'Markdown'`.
- Telegram 64-byte limit en callback_data: usar índices numéricos (`rotiseria:precio_item:${idx}`).
- En Windows usar `pnpm.cmd` por soporte de OS. Para pnpm install/add usar BypassSandbox: true.

## Remediación Pre-Piloto (2026-10-12)
- Bloque 1: ARCH-01 (Kiosco trial trigger), TEN-01/02 (Multi-tenant Rotisería), SEC-02 (Template en invitaciones), AI-01 (Timeouts 20s), SEC-04 (Helmet + trust proxy).
- Bloque 2: BUS-01/02 (ManualPayment actualiza status/subscriptionExpiresAt; ACTIVE sin fecha activa recordatorio), DATA-02 (Tope 999_999_999.99 en schemas monetarios), OPS-01 (Healthcheck /health con verificación real de DB PostgreSQL).
- Quality gates al 100%: typecheck ✓, build ✓, tests 277/277 ✓.

## Próximos pasos
- [ ] Aplicar migración `manual_payments` en staging cuando se apruebe.
- [ ] Siguiente bloque de remediación según prioridades de pre-producción.
