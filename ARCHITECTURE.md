# ARCHITECTURE.md — bot-platform

Fuente de verdad de la arquitectura. Reemplaza a `ARQUITECTURA.md` (documento de
análisis previo, hoy solo referencia histórica). Reglas normativas en `CONSTITUTION.md`.

## 1. Visión

Una base común (`Core`) + productos verticales cerrados (`Templates`):

```
CORE ────────────┬── Gastos (referencia)
                 ├── Kiosco (primer vertical comercial)
                 ├── Panadería
                 └── Barbería
```

El cliente compra un producto cerrado ("Bot Kiosco"). Muchos negocios usan el mismo
template. La diferencia entre clientes del mismo template es **configuración/datos**,
nunca código. Prohibidos los forks por cliente.

Equipo pequeño: se prioriza simplicidad, velocidad, seguridad y mantenibilidad.
Las abstracciones existen porque hay evidencia de reutilización, no por especulación.

## 2. Estructura del repositorio

```
src/core/            comportamiento compartido + contratos (sin grammY/Prisma/Express)
src/infrastructure/  adaptadores: telegram, ai providers, stt, persistence, http
src/templates/<id>/  vertical: actions, commands, menú, prompts, schemas, domain,
                     persistence, format, seeds
src/app/             composition root: config, container (wiring), bootstrap
prisma/              schema + migraciones (core + templates activos)
scripts/             utilidades manuales (invitaciones, seeds). Sin lógica de negocio.
tests/               tests (vitest; fakes en memoria por defecto)
docs/adr/            decisiones importantes, 1 archivo corto por decisión
```

Regla de dependencias (una sola dirección): `core` ← `infrastructure`, `core` ←
`templates`; solo `src/app/container.ts` importa todo junto, con imports estáticos.
Sin `import()` dinámico, sin loaders de plugins, sin descubrimiento por convención.

Un solo paquete npm (no monorepo). Un solo proceso. Una sola base de datos.

## 3. Core vs Templates vs Infrastructure vs App

**Core** (comportamiento compartido): Telegram runtime (contexto, middleware, dispatch,
teclados, descarga de archivos, error boundary, rate limit), pipeline de mensaje,
Action Registry, interpretación IA + validación, STT, identidad (usuarios, membresías,
roles, invitaciones, tokens API), `TenantContext`, estado de conversación,
confirmaciones, auditoría, estado/trial del negocio, config, logging, errores,
infraestructura de persistencia (cliente Prisma, repos de tablas core, scope por tenant),
servidor HTTP base (app, auth, error handler, health).

**Templates** (comportamiento de vertical): actions, comandos, menú, prompts, schemas
Zod, servicios de dominio, repositorios propios, tablas propias, formatters y textos,
seeds. Módulos TypeScript normales registrados en el composition root.

**Infrastructure** (adaptadores): implementan contratos de `core` (grammY, OpenRouter,
Groq/OpenAI-STT, Prisma, Express). No conocen templates.

**App** (composición): carga config, arma dependencias, registra bots por vertical,
bootstrap + graceful shutdown.

Frontera práctica: el mecanismo de catálogo/whitelist es Core; su contenido es del
template. Si algo se repite en 2 casos reales, puede subir a Core. Si no, queda en el
template aunque "parezca reutilizable".

## 4. Multi-tenancy

PostgreSQL compartido, shared schema, `businessId` en toda tabla de dominio
(ver ADR-002). Flujo obligatorio por update/request:

```
Telegram Update → identidad Telegram → membership → TenantContext
  → Action → Domain Service → Repository → PostgreSQL
```

- El `businessId` efectivo sale de identidad + membership verificada, jamás de input
  de usuario ni headers. Prohibido `x-user-id`.
- Repositorios tenant-scoped: reciben el contexto en constructor o primer argumento;
  nunca exponen `prisma` crudo a templates. `findAll()` sin contexto no debe existir.
- Tablas de dominio: `businessId NOT NULL`, índices que empiezan por `businessId`,
  uniques compuestos `@@unique([businessId, ...])`.

## 5. Usuarios, roles, vinculación

- Cada persona usa su propio Telegram (sin cuentas compartidas). Las operaciones de
  dominio registran el usuario actor (quién hizo qué).
- Roles mínimos: `OWNER` (opera + gestiona invitaciones, revoca usuarios, ve auditoría)
  y `EMPLOYEE` (opera). Sin matriz granular de permisos; el código debe permitir
  ampliar roles sin rehacer la arquitectura.
- Acceso = identidad Telegram + invitación de un solo uso. Sin usuario/contraseña.
  Invitación: token aleatorio (`crypto.randomBytes` ≥ 32 bytes, base64url), hash en DB,
  expiración, un solo uso, revocable, con rol a asignar, auditada.
- Deep link: `https://t.me/<BOT>?start=<TOKEN>`. El primer OWNER lo recibe de
  nosotros; luego los OWNER generan invitaciones para empleados.
- Alta inicial manual (scripts/DB) con el mismo modelo que usará la futura web
  administrativa. La web admin NO se implementa ahora; solo se deja el hueco.

## 6. Telegram: un bot por vertical

```
Telegram ──┬── Bot Gastos    → Template gastos
           ├── Bot Kiosco    → Template kiosco
           ├── Bot Panadería  → Template panadería
           └── Bot Barbería   → Template barbería
                        ↓
                       CORE (compartido)
```

- Cada bot conoce únicamente las acciones de su template. Un usuario de Kiosco nunca
  ve turnos de barbería.
- Registro estático en config/composition root (un token por vertical en env). Nada de
  multi-bot dinámico por cliente en esta etapa; el modelo permite agregar bots después.
- Handlers delgados: traducen eventos a casos de uso del pipeline. Sin lógica de
  negocio en handlers.

## 7. Menú + freestyle convergen en Actions

Menú fijo visible + texto/audio libre. Ambos caminos ejecutan las **mismas** acciones:

```
MENÚ → Registrar venta → bot pide datos → usuario responde → Action registrar_venta
"Vendí 3 Coca a 2000 c/u" → IA interpreta → Action registrar_venta
```

El menú no duplica lógica; el freestyle no abre caminos alternativos. Ambos terminan en
`Action` → `Domain Service`.

## 8. IA: interpreta, no ejecuta

```
Mensaje → Interpretación IA → Intent/Action + datos → Validación (Zod)
  → Confirmación → Action → Domain Service → Repository
```

- La IA propone `{ action, params }` dentro del registry del template. El código valida:
  acción ∈ whitelist, params pasan el schema, rol y estado del negocio lo permiten.
  1 reintento de reparación como máximo. Sin agentes autónomos ni workflows de agentes.
- Implementación inicial: structured output con dispatch (generalización del
  `ExpenseParser` actual). Tool calling queda como evolución futura del adaptador, sin
  reescribir templates (ADR-006).

## 9. Conversaciones multi-mensaje

Las acciones pueden requerir varios mensajes (pedir datos faltantes, confirmar).
El bot usa el estado de conversación (`ConversationState`: business + usuario, con TTL)
para completar información sin empezar de cero. Siempre se pide al usuario enviar todos
los datos juntos cuando sea posible. Existe `/cancelar`: al cancelar se pierde el estado
pendiente. Sin reanudación compleja de conversaciones antiguas (fuera de alcance).

## 10. Audio = texto

Texto y audio tienen las mismas capacidades: el audio puede iniciar acciones, completar
datos y responder preguntas del flujo. STT es Core; la interpretación posterior es la
misma que para texto.

## 11. Confirmación obligatoria en mutaciones

Toda operación que escriba/modifique/elimine requiere confirmación explícita **antes**
de ejecutarse en DB (en bot: paso visible Sí/No; en API: la request autenticada es la
confirmación). Aplica sobre todo a datos interpretados por IA, stock, eliminaciones y
cambios destructivos. Las lecturas no requieren confirmación.

## 12. Estado del negocio y suscripción

Estados: `TRIAL | ACTIVE | READ_ONLY | SUSPENDED`.

- **Trial: 10 días.** NO lo inicia la creación del `Business`, ni `/start`, ni lecturas,
  ni el menú. Lo inicia la primera **acción real de negocio** (escritura de dominio:
  registrar venta/gasto, modificar stock, crear producto…). Durante el trial, todo
  disponible.
- **Al expirar el trial → `READ_ONLY`**: puede consultar (históricos, resúmenes), no
  puede modificar. No se borran datos.
- **`SUSPENDED`**: bloquea todo con mensaje claro.
- **Suscripción (modelo, sin billing aún)**: el negocio pasa a `ACTIVE` con fecha de
  activación, vencimiento, período y tolerancia. Política permisiva: período de gracia
  configurable con recordatorios, sin corte inmediato. Sin Mercado Pago ni billing
  automático en esta etapa. Los campos existen para que la futura suscripción no
  requiera remodelar.
- El pipeline evalúa el estado antes de cada acción.

## 13. Configuración del negocio

La hacemos nosotros (sin sistema editable por el cliente salvo lo estrictamente
necesario): nombre, productos, stock inicial, categorías, datos del template. A futuro,
panel administrativo. Todo cambio de configuración relevante queda auditado.

## 14. Auditoría

`AuditLog` reutilizable desde Core: quién, qué, cuándo, sobre qué entidad. Las
operaciones de dominio registran el actor. Sin UI de visualización por ahora.

## 15. Base de datos

Core: `Business`, `User`, `Membership`, `Bot` (registro por vertical, si aporta valor;
si no, config estática — ver ADR-003), `Invitation` (JoinCode), `ConversationState`,
`AiUsageLog`, `AuditLog`.

Templates: sus propias tablas tipadas con `businessId`. Ejemplo kiosco: `Product`,
`Sale`, `Purchase`, `MoneyMovement`, `StockMovement`. Prohibida la tabla genérica
`Record { type, jsonData }` como modelo principal. Conceptos como `Transaction` o
`MoneyMovement` compartidos solo suben a Core cuando más de un template los necesite
idénticos (hoy no).

Prisma con un solo `schema.prisma` (core + templates activos). Si con 3+ templates el
schema se vuelve hotspot de merge, migrar a migraciones SQL por template (documentado,
no implementado).

## 16. Kiosco (primer vertical comercial)

Bot simple, no un ERP. Desde Telegram: productos (CRUD + stock inicial), stock
(consultar, aumentar/disminuir/ajustar, movimientos ligados a ventas/compras),
ventas (multi-producto, cantidades, total, descuento de stock), compras/gastos/
movimientos de dinero, consultas (resumen día/mes, histórico, ventas, gastos, stock).
Evaluar "stock bajo" (actual vs mínimo, consulta simple) solo si encaja sin complicar.
UX: `/start` → menú → acción, o freestyle directo ("Vendí dos Coca y un alfajor por
5000"). Sin dashboards, apps, paneles ni analítica compleja.

## 17. Reutilización de `bot-gastos` (resumen)

- **Directo/casi directo a Core o Infrastructure:** `IAIProvider` + OpenRouter,
  STT completo, config Zod, logger, errores base, prisma singleton, Express app +
  error handler, DI por constructor, patrón repositorio, Dockerfile/compose, tests
  como referencia.
- **Conceptual (requiere refactor):** `ExpenseParser` → intérprete genérico +
  dispatch; handlers de bot → pipeline; rutas API → montaje por template.
- **Queda en `templates/gastos`:** dominio expenses/budgets/categories, schemas,
  prompts, comandos, formatters con iconos, tablas `Expense/Budget/Category`.
- **No se reutiliza:** token API sin firma (reemplazar por HMAC), bypass `x-user-id`
  (eliminar), `mobile/`, N+1 e in-memory aggregates (reescribir en SQL).

## 18. No construir ahora

Dashboard web, app Flutter, microservicios, sistema de plugins, agentes autónomos,
workflows de agentes, multi-bot dinámico por cliente, DB/schema por tenant, WhatsApp,
integración bancaria, Mercado Pago, AFIP, analytics avanzado, notificaciones
complejas, billing automático, configuración avanzada para clientes, personalización
de código por cliente. Si aparece la necesidad: documentarla y seguir con el alcance.

## 19. Decisiones abiertas (resumen; detalle en `docs/adr/` y §10 del plan)

Bot central vs por cliente (hoy: un bot por vertical), hosting productivo,
Supabase vs Postgres plano, webhook vs polling en producción, alcance público de la
API, RLS, i18n, comportamiento exacto al terminar el trial. Si una decisión depende de
información que aún no tenemos, se diseña el hueco y se deja pendiente.

