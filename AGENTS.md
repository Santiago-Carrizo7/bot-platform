# AGENTS.md — bot-platform

## 1. Contexto & stack

Plataforma para bots de Telegram verticalizados (Kiosco, Panadería, Barbería…).
Base reutilizable (`core/`) + productos cerrados por vertical (`templates/`).
Referencia: `bot-gastos` (repo hermano). Fuente de verdad: `CONSTITUTION.md`,
`ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md`, `docs/adr/`.

- **Runtime:** Node.js 20+ con ESM (`"type": "module"`, imports con extensión `.js`).
- **Lenguaje:** TypeScript estricto (`strict`, `moduleResolution: NodeNext`).
- **Core:** grammY (Telegram), Prisma + PostgreSQL 16, Zod, Express (API), OpenRouter (LLM), STT OpenAI-compatible (Groq Whisper).
- **Package manager:** `pnpm` (en Windows `pnpm.cmd`). Prohibido mezclar con npm/yarn.
- **Tests:** vitest. **Quality gates antes de dar por terminada cualquier tarea:** `pnpm typecheck`, `pnpm test`, `pnpm build`.
- **Commits:** español, Conventional Commits (`tipo(alcance): descripción`). Nunca `git push` sin pedido explícito.
- **Cero secretos** en docs, código, tests o commits.

## 2. Estructura & dependencias (una sola dirección)

```
src/core/            contratos + comportamiento compartido (no conoce grammY/Prisma/Express)
src/infrastructure/  adaptadores: telegram, ai providers, stt, persistence, http
src/templates/<id>/  vertical: actions, commands, menú, prompts, schemas, domain, persistence, format
src/app/             composition root: config, container (wiring), bootstrap
prisma/              schema + migraciones (core + templates activos)
scripts/             utilidades manuales (invitaciones, seeds) — no lógica de negocio
tests/               tests (unitarios por defecto; integración solo con DB local)
docs/adr/            decisiones importantes, 1 archivo corto por decisión
```

- `core` nunca importa `templates` ni adaptadores concretos (solo sus interfaces).
- `infrastructure` implementa contratos de `core`; no importa `templates`.
- `templates` importa `core` (y tipos de `infrastructure` si hace falta).
- Solo `src/app/container.ts` importa todo junto. Templates registrados por import estático. Prohibido `import()` dinámico / loaders de plugins.

## 3. Multi-tenancy (crítico)

- Todo acceso a datos tenant-scoped exige `TenantContext` (bot → usuario Telegram → membership → business) resuelto **antes** de la acción. Los repositorios de dominio reciben el contexto en el constructor o como primer argumento; nunca exponer `prisma` crudo a templates.
- El `businessId` efectivo sale de identidad + membership verificada, jamás de input del usuario ni de headers arbitrarios. Prohibido `x-user-id`.
- Verificar membership (y rol si la acción lo exige) antes de ejecutar.
- Toda tabla de dominio lleva `businessId NOT NULL`, índices que empiezan por `businessId`, y uniques compuestos `@@unique([businessId, ...])`.
- El estado del negocio (`TRIAL | ACTIVE | READ_ONLY | SUSPENDED`) se evalúa en el pipeline antes de cada acción: `TRIAL` válido y `ACTIVE` (incluido período de gracia) pueden escribir; `READ_ONLY` solo lee; `SUSPENDED` bloquea todo con mensaje claro.
- El trial (10 días por defecto) lo inicia la primera **acción real de negocio** (escritura de dominio), nunca `/start`, lectura, menú o creación del registro.

## 4. Telegram

- Handlers delgados: traducen el evento a un caso de uso del pipeline. Nada de lógica de negocio en handlers.
- Menú y freestyle (texto/audio) convergen en las mismas `Action` del template. El menú no duplica lógica; el freestyle no abre caminos alternativos.
- Un bot por vertical (registro estático en config/composition root). Un bot solo conoce las acciones de su template.
- `/cancelar` siempre disponible durante una conversación multi-mensaje; cancelar/descartar pierde el estado pendiente.

## 5. IA

- La IA interpreta; el código ejecuta. Salida esperada: `{ action, params }` dentro del registry del template.
- Toda salida de IA se valida (acción ∈ whitelist, params pasan el schema Zod de la acción; 1 reintento de reparación como máximo).
- Toda mutación requiere confirmación explícita previa (en bot: paso visible Sí/No; en API: la request autenticada es la confirmación).
- Loguear el output crudo del modelo con `businessId` para depurar. Rate limit por usuario y presupuesto por negocio (un trial no puede generar factura abierta).

## 6. Seguridad

- Invitaciones: token aleatorio (`crypto.randomBytes` ≥ 32 bytes, base64url), hash en DB, expiración, un solo uso, revocables, auditadas. Deep link `https://t.me/<BOT>?start=<TOKEN>`.
- API: tokens firmados (HMAC con `API_SECRET`) con expiración y `businessId` en el payload firmado. Sin firma no hay acceso.
- Secrets solo en environment. Tokens de bot cifrados si van a DB. Logs sin PII sensible ni secretos.
- Auditoría (`AuditLog`) en todo lo relevante: quién, qué, cuándo, sobre qué entidad. Las operaciones de dominio registran el usuario actor.

## 7. Código

- TypeScript `strict`, sin `any` salvo justificado y acotado.
- Zod en todos los bordes: env config, input de Telegram (vía schemas de acción), payloads de API, salida de IA.
- DI por constructor donde aporte valor (servicios reciben repos/servicios, no los importan).
- No abstraer prematuramente (regla de los 2 para llevar algo a Core). No duplicar lógica de negocio entre menú/freestyle/API: converger en `Action` + domain service.
- Formatters y textos del template viven en el template; helpers genéricos (moneda/fecha con locale por tenant) viven en Core.
- Prisma `Decimal` se serializa como string en JSON: convertir a `Number` en los bordes.

## 8. Testing

- Todo flujo crítico tiene tests: tenant isolation, vinculación por invitación (válida/expirada/usada/revocada), roles, expiración de trial, `READ_ONLY` bloquea escrituras, confirmación obligatoria en mutaciones, dispatch de acciones, parsing/interpretación IA (con provider mockeado, sin red).
- Unitarios con fakes en memoria por defecto (sin DB). Integración con DB local solo cuando aporte valor (marcarlos y documentar cómo correrlos).
- Regresión de prompts: fixtures de mensajes reales por template, sin llamadas de red.

## 9. Proceso de trabajo

1. Leer `CONSTITUTION.md` + fase actual de `IMPLEMENTATION_PLAN.md` antes de empezar.
2. Implementar en slices verticales pequeños y verificables (pipeline → acción → DB → test).
3. Correr los 3 gates (`typecheck`, `test`, `build`) antes de dar por hecha la tarea; si algo falla, corregirlo.
4. Decisiones importantes nuevas → ADR corto en `docs/adr/` (formato: contexto, decisión, consecuencias).
5. No implementar nada de la lista "NO construir ahora" (`ARCHITECTURE.md` §no-alcance) por iniciativa propia: si aparece la necesidad, documentarla y seguir con el alcance.
6. Mantener `IMPLEMENTATION_PLAN.md` actualizado (marcar fases/gates completados).

## 10. Protocolo de memoria (`MEMORY.md`)

Reciprocidad entre este archivo y `MEMORY.md`: las reglas viven acá, el contexto
fresco vive allá. Esto permite trabajar en distintos chats, con distintos agentes
(yo, otros agentes, tu amigo desde GitHub) manteniendo la misma forma de trabajar.

- **Orden de lectura de un agente nuevo:** `AGENTS.md` → `MEMORY.md` →
  `CONSTITUTION.md` → `ARCHITECTURE.md` (según necesidad) →
  `IMPLEMENTATION_PLAN.md` (fase actual) → `docs/adr/` (solo la decisión relevante).
- **Inicio de sesión:** leer `MEMORY.md` para retomar estado, decisiones vigentes,
  gotchas y próximos pasos. No asumir nada que contradiga lo que dice.
- **Fin de tarea:** actualizar `MEMORY.md` (estado, decisiones, gotchas nuevos,
  próximos pasos). No dejarlo desactualizado.
- **Límite estricto:** mantenerlo bajo **50-60 líneas**. Podar lo obsoleto.
- **Promoción de reglas:** si un patrón se vuelve permanente, moverlo a `AGENTS.md`
  (u a `CONSTITUTION.md` si es normativa) y sacarlo de `MEMORY.md`.
- **Cero secretos** en `MEMORY.md` y en `AGENTS.md`.
