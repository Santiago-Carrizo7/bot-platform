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
  se asientan de inmediato sin confirmación; audios y ráfagas van a `registrar_lote`
  con confirmación numerada y corrección interactiva ("el 2 es 4000", "borrar 2" o botones).
  Al confirmar lote, se cierra la sesión limpia sin retener al usuario.
  Concepto y categoría no se duplican si son idénticos (ej. Alquiler).
  Jerga argentina (palos, lucas, k, millones) y frases complejas delegan al LLM.
  Calculadora: atajo determinístico y asesor de 3 escenarios (+30%, +50%, +75%) si no pasa %.
- Rotiseria: docenas y media docena por tarifa (3 precios: unitario, media docena, docena);
  preview detallada en lote de envíos; tips de formato en módulo de bebidas;
  turno operativo 00-05 AM; anulación interactiva; auto-registro de zonas; matcher por sabor raíz;
  reset de borrador ante nueva comanda; parseModification con palabras numéricas y docenas;
  módulo de bebidas (`/bebidas`); botones `rotiseria:quitar_linea:<idx>`;
  RBAC para `EMPLOYEE`; estadísticas y ranking de bebidas (`rotiseria:stats_bebidas:<period>`).
- Confirmación rotisería: 4 botones (`confirm:yes`, `confirm:no`, `rotiseria:modificar`, `rotiseria:fecha`) + botones para quitar ítems en modificación o con precio $0.

- IA en cascada (`FallbackAIProvider`): Groq (Llama 3.3) -> OpenRouter -> Gemini.

## Gotchas
- Telegram 64-byte limit en callback_data: usar índices numéricos (`rotiseria:precio_item:${idx}`).
- En Windows usar `pnpm.cmd` por soporte de OS.
- Zod schemas: campos auxiliares deben declararse `.nullable().optional()` para no invalidar `safeParse`.

## Próximos pasos
- [ ] Push de la rama y deploy de migraciones en Supabase/Render.
- [ ] Configurar `TELEGRAM_BOT_TOKEN_ROTISERIA` en el entorno de staging.
- [ ] Probar interacciones en Telegram de los 3 bots (gastos, kiosco y rotisería).
