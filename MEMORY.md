# Project Memory (bot-platform)
> Memoria episódica entre sesiones/chats/agentes. Mantener bajo **50-60 líneas**.
> Resumir o eliminar lo que ya no aporte valor. Si algo se vuelve regla permanente,
> moverlo a `AGENTS.md` (o a `CONSTITUTION.md` si es normativa). **NUNCA** secretos.

## Estado actual
- Phase 0–3 + Sprint A + webhook en verde. Webhook en modo activo en Render.
- Staging: Render free + Supabase + cron-job cada 12 min a /health (no duerme).
- Templates: `gastos`, `kiosco` y `rotiseria` (ADR-011: docenas multi-tarifa,
  jornada 00-05 AM, delivery zones y flete `🛵 Envíos`, ranking de zonas de flete,
  edición rápida de precios de zona, guía explicada de carga por lote,
  anulación 5 vs 10 ventas, separación `/menu` y `/carta`, replyMenu [1,2,2]).
- 190 tests unitarios pasando limpios (191 total con integración opcional).
- Quality gates al 100%: `pnpm typecheck` OK, `pnpm test` OK, `pnpm build` OK.
- Stack: Node 20+ / pnpm / TS estricto / grammY / Prisma + PG16 / Zod / Express / vitest.

## Decisiones vigentes
- Monolito modular; tenancy por `businessId`; un bot por vertical (registro estático);
  templates como módulos estáticos; IA con dispatch + Zod; confirmación en escrituras;
  trial 10 días desde 1ª escritura → `READ_ONLY`; tablas tipadas, sin `Record` genérico.
- Rotisería UX y Menú: `/menu` muestra guía amigable interactiva; `/carta` lista productos y combos;
  denominación unificada a `🛵 Envíos` (tarifas y botón en comanda); creación de comida como `➕ Crear comida`;
  teclado persistente [1, 2, 2] activo tras comandos para mantener accesos rápidos.
- Rotisería Ítems no catalogados: `calculatePricing` nunca arroja AppError por ítem ausente;
  los cotiza a $0 (categoría `especial`) con botón de precio `rotiseria:precio_item:${idx}` (límite 64b).
- Rotisería Delivery: tabla `rotiseria_delivery_zones` con `barrios[]` normalizados;
  `deliveryFee === 0` es envío bonificado ($0), `deliveryFee === null` es mostrador;
  segregación contable en reportes de turno y estadísticas (`foodTotal`, `deliveryTotal`).
- IA en cascada (`FallbackAIProvider`): Groq (Llama 3.3) -> OpenRouter -> Gemini.

## Gotchas
- Telegram 64-byte limit en callback_data: usar índices numéricos (`rotiseria:precio_item:${idx}`).
- En Windows usar `pnpm.cmd` por soporte de OS.
- Zod schemas: campos auxiliares deben declararse `.nullable().optional()` para no invalidar `safeParse`.

## Próximos pasos
- [ ] Push de la rama y deploy de migraciones en Supabase/Render.
- [ ] Configurar `TELEGRAM_BOT_TOKEN_ROTISERIA` en el entorno de staging.
- [ ] Probar interacciones en Telegram de los 3 bots (gastos, kiosco y rotisería).
