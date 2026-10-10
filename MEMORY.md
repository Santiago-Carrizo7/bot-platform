# Project Memory (bot-platform)
> Memoria episódica entre sesiones/chats/agentes. Mantener bajo **50-60 líneas**.
> Resumir o eliminar lo que ya no aporte valor. Si algo se vuelve regla permanente,
> moverlo a `AGENTS.md` (o a `CONSTITUTION.md` si es normativa). **NUNCA** secretos.

## Estado actual
- Phase 0–3 + Sprint A + webhook en verde. Webhook en modo activo en Render.
- Staging: Render free + Supabase + cron-job cada 12 min a /health (no duerme).
- Templates: `gastos`, `kiosco` y `rotiseria` (ADR-011: docenas multi-tarifa,
  jornada 00-05 AM, anulación auditada, replyMenu [1,2,2], `registrar_venta`, comanda formal,
  edición interactiva con "quitar/sacar", semáforo 7 días, cambio precio guiado, stats 3 niveles).
- 172 tests unitarios pasando limpios (173 total con integración opcional).
- Quality gates al 100%: `pnpm typecheck` OK, `pnpm test` OK, `pnpm build` OK.
- Stack: Node 20+ / pnpm / TS estricto / grammY / Prisma + PG16 / Zod / Express / vitest.

## Decisiones vigentes
- Monolito modular; tenancy por `businessId`; un bot por vertical (registro estático);
  templates como módulos estáticos; IA con dispatch + Zod; confirmación en escrituras;
  trial 10 días desde 1ª escritura → `READ_ONLY`; tablas tipadas, sin `Record` genérico.
- Rotisería: docenas por tarifa (`priceDozen`); turno operativo 00-05 AM;
  anulación interactiva (última o lista de 5) con audit `sale.cancelled`; cambio de precios
  por categoría con audit `product.price_updated`; semáforo de 7 días con drilldown por comanda.
- Confirmación rotisería: 4 botones (`confirm:yes`, `confirm:no`, `rotiseria:modificar`, `rotiseria:fecha`).
- Productos no reconocidos: 100% no reconocidos aborta sin draft; parciales avisa en viñeta.
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
- [ ] Push de la rama `feature/template-rotiseria` y deploy de migraciones en Supabase/Render.
- [ ] Configurar `TELEGRAM_BOT_TOKEN_ROTISERIA` en el entorno de staging.
- [ ] Probar interacciones en Telegram de los 3 bots (gastos, kiosco y rotisería).
