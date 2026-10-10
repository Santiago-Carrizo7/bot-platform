# Project Memory (bot-platform)
> Memoria episódica entre sesiones/chats/agentes. Mantener bajo **50-60 líneas**.
> Resumir o eliminar lo que ya no aporte valor. Si algo se vuelve regla permanente,
> moverlo a `AGENTS.md` (o a `CONSTITUTION.md` si es normativa). **NUNCA** secretos.

## Estado actual
- Phase 0–3 + Sprint A + webhook en verde. Webhook en modo activo en Render.
- Staging: Render free + Supabase + cron-job cada 12 min a /health (no duerme).
- Templates: `gastos`, `kiosco` y `rotiseria` (ADR-011: docenas multi-tarifa,
  jornada 00-05 AM, anulación auditada, replyMenu [1,2,2], `registrar_venta`, comanda formal,
  edición interactiva con "quitar/sacar", semáforo 7 días, cambio precio guiado, stats 3 niveles,
  desambiguación con catálogo cerrado, gestión integral de promos y selector 5 vs 10 ventas).
- 177 tests unitarios pasando limpios (178 total con integración opcional).
- Quality gates al 100%: `pnpm typecheck` OK, `pnpm test` OK, `pnpm build` OK.
- Stack: Node 20+ / pnpm / TS estricto / grammY / Prisma + PG16 / Zod / Express / vitest.

## Decisiones vigentes
- Monolito modular; tenancy por `businessId`; un bot por vertical (registro estático);
  templates como módulos estáticos; IA con dispatch + Zod; confirmación en escrituras;
  trial 10 días desde 1ª escritura → `READ_ONLY`; tablas tipadas, sin `Record` genérico.
- Rotisería: catálogo cerrado (whitelist estricta); desambiguación (`sugerencia`) con botones resolver/ignorar;
  promos auditadas con inmutabilidad en estadísticas históricas (`RotiseriaSaleItem.promoId`);
  menú azul de 9 comandos exactos; selector de historial 5 vs 10 ventas in-place.
- Confirmación rotisería: 4 botones (`confirm:yes`, `confirm:no`, `rotiseria:modificar`, `rotiseria:fecha`).
- Kiosco (ADR-011): MVP financiero ágil, cero inventario. Movimientos `MoneyMovement`.
- IA en cascada (`FallbackAIProvider`): Groq (Llama 3.3) -> OpenRouter -> Gemini.
- Visión (`VisionService`): Gemini 2.0 Flash -> Groq Vision; límite 5 fotos/día por negocio.

## Gotchas
- `migration.sql` en UTF-8 sin BOM: PowerShell redirect `>` escribe UTF-16LE. Convertir siempre.
- En Windows usar `pnpm.cmd`. Prohibido mezclar con npm/yarn.
- Webhook grammY: timeout fijado a 30s con `onTimeout: 'return'`.
- Zod en schemas de acción: los campos internos de control en borradores (ej: `_modifying`)
  deben declararse como opcionales para no ser eliminados por `.safeParse()`.

## Próximos pasos
- [ ] Push de la rama y deploy de migraciones en Supabase/Render.
- [ ] Configurar `TELEGRAM_BOT_TOKEN_ROTISERIA` en el entorno de staging.
- [ ] Probar interacciones en Telegram de los 3 bots (gastos, kiosco y rotisería).
