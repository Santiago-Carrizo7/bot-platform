# CONSTITUTION.md — bot-platform

Normas inviolables. Están por encima de cualquier implementación, atajo o conveniencia.
Si una tarea entra en conflicto con alguna de estas reglas, la tarea se redefine. La Constitución no.

## 1. Tenant isolation is non-negotiable

Ninguna consulta de datos de negocio puede ejecutarse sin `TenantContext` resuelto
(identidad Telegram → membership → business). Un repositorio tenant-scoped no se puede
construir sin contexto de tenant. Una fuga de datos entre negocios es el peor fallo posible
del sistema.

## 2. Telegram identity + invitation = access to business

No hay usuario + contraseña para Telegram. El acceso a un negocio se obtiene con identidad
de Telegram más una invitación válida (token aleatorio, con expiración, de un solo uso,
revocable, auditado). Sin membership no hay acciones de dominio. Sin excepciones.

## 3. AI interprets, application executes

La IA interpreta mensajes y propone `{ action, params }` dentro de un conjunto cerrado de
acciones. Solo el código decide qué se ejecuta: la acción debe existir en el registry del
template, los parámetros deben pasar su schema Zod, y el rol/status del tenant deben
permitirlo. No hay agentes autónomos. No hay ejecución de nada que el modelo invente.

## 4. Every mutation requires confirmation

Toda operación que escriba, modifique o elimine datos requiere confirmación explícita del
usuario antes de ejecutarse. Las lecturas no. En el bot la confirmación es un paso visible
(Sí/No). En la API, la request explícita y autenticada es la confirmación.

## 5. Core is shared behavior, Templates are vertical behavior

Core contiene comportamiento compartido y probado por más de un caso. Template contiene
comportamiento propio de una vertical. Si algo vive en Core, debe existir evidencia de
reutilización (regla de los 2: un segundo caso real lo necesita).

## 6. No customer forks

Nunca hay ramas de código por cliente, ni `if (businessId === 'X')`, ni copias de un
template. La diferencia entre clientes del mismo template es configuración/datos.
Lo que tres clientes pidan distinto se convierte en opción de configuración del template.
Lo que requiera lógica distinta es un template nuevo.

## 7. No premature abstractions

No se abstrae "por si acaso". No hay plugins, event buses, workflows de agentes, CQRS ni
microservicios. La abstracción más simple que resuelve el caso real es la correcta.

## 8. Business state controls write/read capabilities

El estado del negocio (`TRIAL | ACTIVE | READ_ONLY | SUSPENDED`, con trial de 10 días
desde la primera acción real y período de gracia permisivo) determina qué puede hacer el
usuario. El pipeline lo evalúa antes de ejecutar cualquier acción. El trial lo inicia el
uso real, nunca la creación del registro ni la navegación.

## 9. Security takes priority over convenience when tenant data is involved

Tokens firmados y con expiración. Secretos solo en environment (nunca en código, logs ni
DB sin cifrar). Sin bypass de identidad (nunca `x-user-id`). Logs sin datos sensibles.
Auditoría de quién hizo qué, cuándo y sobre qué.

## 10. The system must remain understandable to a small team

Módulos claros, servicios simples, repositorios simples, TypeScript estricto, validación
en los bordes. Un desarrollador junior/semi-senior debe poder leer el flujo completo
(update → acción → DB) sin perderse. Si una solución requiere un diagrama para
entenderse, probablemente es demasiado compleja.

## 11. Do not introduce infrastructure complexity without a concrete need

Un solo proceso, una sola base de datos, long polling, sin dashboard web, sin billing
automático, sin schema-por-tenant, sin DB-por-cliente, hasta que un caso real lo exija.
Cuando aparezca la necesidad, se documenta primero y se implementa después.
