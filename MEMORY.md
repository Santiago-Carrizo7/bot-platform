# Project Memory (bot-platform)
> Memoria episódica entre sesiones/chats/agentes. Mantener bajo **50-60 líneas**.
> Resumir o eliminar lo que ya no aporte valor. Si algo se vuelve regla permanente,
> moverlo a `AGENTS.md` (o a `CONSTITUTION.md` si es normativa). **NUNCA** secretos.

## Estado actual
- Phase 0–3 + Sprint A + webhook en verde. Webhook en modo activo en Render.
- Módulo Catálogo Rotisería: CatalogService, /catalogo, /producto_nuevo (OWNER) implementados.
- Quality gates al 100%: `pnpm typecheck` OK, `pnpm test` (290/290 tests) OK, `pnpm build` OK.
- Stack: Node 20+ / pnpm / TS estricto / grammY / Prisma + PG16 / Zod / Express / vitest.

## Decisiones vigentes
- Monolito modular; tenancy por `businessId`; un bot por vertical (registro estático);
  templates como módulos estáticos; IA con dispatch + Zod; confirmación en escrituras;
  trial 10 días desde 1ª escritura → `READ_ONLY`; tablas tipadas, sin `Record` genérico.
- Rotisería Catálogo: `CatalogService` con `createProduct` (uniqueness check), `updateProductCategory`
  (persistencia de categoría y FKs), `toggleProductStatus` (oculta/muestra sin borrar ventas históricas),
  `listCategories` (distintas activas). Handlers `/catalogo` y `/producto_nuevo` protegidos por rol `OWNER`.
- `ActionDef.skipConfirmation`: escrituras directas (ventas Kiosco) inician trial y respetan `READ_ONLY`.
- TenantResolver: invitaciones validan coincidencia estricta de `templateId` con el bot receptor.
- IA/Visión: timeout estricto de 20s en llamadas HTTP externas; Express con `trust proxy 1` y `helmet`.

## Gotchas
- Telegram Markdown V1 rompe con `_` en URLs: enlaces deep link deben enviarse sin `parseMode: 'Markdown'`.
- Telegram 64-byte limit en callback_data: usar índices numéricos (`rotiseria:precio_item:${idx}`).
- En Windows usar `pnpm.cmd` por soporte de OS. Para pnpm install/add usar BypassSandbox: true.

## Próximos pasos
- [ ] Aplicar migración `manual_payments` en staging cuando se apruebe.
- [ ] Integrar reportes o filtros adicionales de catálogo según feedback del piloto.

