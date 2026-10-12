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

- Kiosco: 'ventas' y 'gastos' como acciones ágiles (`isContinuous`); ventas individuales
  se asientan de inmediato sin confirmación; audios y ráfagas van a `registrar_lote`.
  RBAC Kiosco: `consultar_resumen` (`roles: ['OWNER']`), callbacks `stats:*` bloqueados para `EMPLOYEE`,
  menú inline y teclado persistente reemplazan estadísticas por `📋 Movimientos` para empleados.
  `/invitar`: menú interactivo (🤝 Socio vs 👤 Empleado) sin romper Markdown V1 por guiones bajos en links.
  Multi-dueño soportado de forma nativa (múltiples membresías `OWNER` por negocio).
- Rotiseria: docenas por tarifa; turno 00-05 AM; anulación interactiva; RBAC EMPLOYEE.
- IA en cascada (`FallbackAIProvider`): Groq (GPT-OSS 120B) -> OpenRouter -> Gemini.

## Gotchas
- Telegram Markdown V1 rompe con `_` en URLs: enlaces deep link deben enviarse sin `parseMode: 'Markdown'`.
- Telegram 64-byte limit en callback_data: usar índices numéricos (`rotiseria:precio_item:${idx}`).
- En Windows usar `pnpm.cmd` por soporte de OS.

## Próximos pasos
- [ ] Verificar deploy automático en Render de los cambios de `main`.
- [ ] Aplicar migración `20261012000000_manual_payments` en staging/Supabase (`prisma migrate deploy`).
- [ ] Probar interacciones en Telegram en vivo del bot Kiosco con usuarios Socio y Empleado.

## Admin v2 (2026-10-12)
- Dashboard + Negocios + Trials + Pagos manuales (`ManualPayment`) + Auditoría + Config.
- Gates: typecheck ✓, build ✓, tests 261/261 ✓.
