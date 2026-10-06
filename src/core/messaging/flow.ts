import { z } from 'zod';
import { AppError } from '../errors/errors.js';
import { evaluateAccess, shouldStartTrial } from '../tenant/business-status.js';
import type { MembershipWithBusiness, TenantContext, User } from '../tenant/entities.js';
import type {
  IAiUsageRepository,
  IBusinessRepository,
  IConversationRepository,
  IMembershipRepository,
} from '../persistence/repositories.js';
import type { ActionContext, ActionDef, TemplateDefinition } from '../actions/registry.js';
import { ActionInterpreter } from '../ai/interpreter.js';
import { roleSatisfies } from '../identity/roles.js';
import { AuditService } from '../audit/audit.service.js';
import type { InvitationService } from '../identity/invitation.service.js';

export interface InlineButton {
  text: string;
  callbackData: string;
}

export interface BotReply {
  text: string;
  parseMode?: 'Markdown';
  inlineKeyboard?: InlineButton[][];
}

export interface ResolutionInfo {
  user: User;
  tenant: TenantContext | null;
  justJoined: boolean;
  memberships: MembershipWithBusiness[];
  needsInvitation: boolean;
}

export interface TextInput {
  resolution: ResolutionInfo;
  text: string;
  firstName?: string;
  now: Date;
}

export interface CallbackInput {
  resolution: ResolutionInfo;
  /** tenant siempre presente en callbacks (los botones solo existen con negocio). */
  data: string;
  now: Date;
}

export interface FlowDeps {
  template: TemplateDefinition;
  interpreter: ActionInterpreter;
  conversations: IConversationRepository;
  businesses: IBusinessRepository;
  membershipRepo: IMembershipRepository;
  audit: AuditService;
  invitations: InvitationService;
  /** Username del bot (sin @) para armar deep links de invitación. */
  inviteBotUsername?: string;
  aiUsage: IAiUsageRepository;
  aiProviderName: string;
  aiModel: string;
  aiDailyLimitPerBusiness?: number;
  conversationTtlMs?: number;
}

const CONFIRM_YES = new Set(['sí', 'si', 'yes', 'confirmar', 'confirmo', 'dale', 'ok']);
const CONFIRM_NO = new Set(['no', 'cancelar', 'cancela', 'cancelo', 'no confirmar']);

const MSG_NEEDS_INVITATION =
  'Para usar este bot necesitás una invitación del negocio. Pedile el enlace de acceso a quien te lo indicó.';
const MSG_SUSPENDED = 'Este negocio está suspendido. Escribinos por otro medio para reactivarlo.';
const MSG_READONLY_WRITE =
  'Este negocio está en modo solo lectura (el período de prueba terminó). Podés consultar, pero no registrar cambios.';
const MSG_UNKNOWN = 'No entendí eso. Probá con el menú o escribime qué querés hacer.';

function md(text: string): BotReply {
  return { text, parseMode: 'Markdown' };
}

export function menuKeyboard(template: TemplateDefinition): InlineButton[][] {
  return template.menu.map((item) => [{ text: item.label, callbackData: `menu:${item.action}` }]);
}

export function confirmKeyboard(): InlineButton[][] {
  return [[{ text: '✅ Confirmar', callbackData: 'confirm:yes' }, { text: '❌ Cancelar', callbackData: 'confirm:no' }]];
}

export async function handleText(deps: FlowDeps, input: TextInput): Promise<BotReply> {
  const { resolution, text, now } = input;
  const trimmed = text.trim();

  // Sin negocio: solo el alta por invitación tiene sentido (eso lo resuelve el middleware).
  if (!resolution.tenant) {
    return md(MSG_NEEDS_INVITATION);
  }
  if (resolution.justJoined) {
    const inviteHint =
      resolution.tenant.membership.role === 'OWNER'
        ? '\n\nComo dueño podés sumar a tu equipo con /invitar.'
        : '';
    return md(
      `${deps.template.welcome(resolution.tenant.business.name, input.firstName)}\n\nYa quedaste vinculado como *${roleLabel(resolution.tenant.membership.role)}*.${inviteHint}`
    );
  }

  const tenant = resolution.tenant;
  const access = evaluateAccess(tenant.business, now);
  await maybePersistStatus(deps, tenant, access.effectiveStatus);
  if (!access.canRead) {
    return md(MSG_SUSPENDED);
  }

  // Comandos
  if (trimmed.startsWith('/')) {
    return handleCommand(deps, tenant, resolution, trimmed, input.firstName, now, access.subscriptionReminder);
  }

  // Botones de la barra persistente: match exacto → acción directa, sin IA.
  // Un tap abandona la conversación en curso (incluso una confirmación pendiente),
  // igual que cambiar de acción por texto.
  const menuHit = deps.template.replyMenu?.find((m) => m.label === trimmed);
  if (menuHit) {
    const menuAction = deps.template.actions.find((a) => a.name === menuHit.action);
    if (!menuAction) return md(MSG_UNKNOWN);
    return startAction(deps, tenant, resolution.user.id, menuAction, {}, now, access, true);
  }

  const active = await getActiveConversation(deps, tenant, resolution.user.id, now);
  if (active && active.phase === 'CONFIRMING' && active.actionName) {
    const lower = trimmed.toLowerCase();
    if (CONFIRM_YES.has(lower)) {
      return confirmPending(deps, tenant, resolution.user.id, now, access);
    }
    if (CONFIRM_NO.has(lower)) {
      await deps.conversations.clear(tenant.business.id, resolution.user.id);
      return md('Cancelado, no se guardó nada.');
    }
    return md('¿Confirmás la operación? Respondé *Sí* para confirmar o *No* para cancelar (o tocá los botones).');
  }

  // Límite diario de IA por negocio (evita factura abierta en trials).
  await enforceAiBudget(deps, tenant.business.id, now);

  // Interpretar (con pista de acción si hay conversación en curso).
  const hintAction = active?.phase === 'COLLECTING' ? (active.actionName ?? undefined) : undefined;
  const dateStr = now.toISOString().slice(0, 10);
  const hints = await deps.template.resolveHints?.(tenant).catch(() => '');
  const interpreted = await deps.interpreter.interpret(
    deps.template.systemPrompt(tenant.business.name, dateStr, hints ?? ''),
    deps.template.actions,
    trimmed,
    { hintAction, referenceDate: now, businessId: tenant.business.id }
  );
  await deps.aiUsage.log({
    businessId: tenant.business.id,
    userId: resolution.user.id,
    provider: deps.aiProviderName,
    model: deps.aiModel,
  });

  const baseData =
    active?.phase === 'COLLECTING' && active.actionName === interpreted.action.name ? active.data : {};
  const merged = mergeData(baseData, interpreted.params);

  // Si el mensaje apunta a otra acción, se abandona la anterior.
  return proceedWithAction(deps, tenant, resolution.user.id, interpreted.action, merged, now, access, {
    freshStart: !active || active.actionName !== interpreted.action.name,
  });
}

export async function handleCallback(deps: FlowDeps, input: CallbackInput): Promise<BotReply> {
  const { resolution, data, now } = input;
  const tenant = resolution.tenant;
  if (!tenant) return md(MSG_NEEDS_INVITATION);

  const access = evaluateAccess(tenant.business, now);
  await maybePersistStatus(deps, tenant, access.effectiveStatus);
  if (!access.canRead) return md(MSG_SUSPENDED);

  if (data === 'confirm:yes') {
    return confirmPending(deps, tenant, resolution.user.id, now, access);
  }
  if (data === 'confirm:no') {
    await deps.conversations.clear(tenant.business.id, resolution.user.id);
    return md('Cancelado, no se guardó nada.');
  }
  if (data.startsWith('menu:')) {
    const actionName = data.slice('menu:'.length);
    const action = deps.template.actions.find((a) => a.name === actionName);
    if (!action) return md(MSG_UNKNOWN);
    return startAction(deps, tenant, resolution.user.id, action, {}, now, access, true);
  }
  if (data.startsWith('biz:')) {
    const membershipId = data.slice('biz:'.length);
    const mine = resolution.memberships.find((m) => m.id === membershipId);
    if (!mine) return md('Ese negocio no está disponible.');
    await deps.membershipRepo.touchLastUsed(membershipId, now);
    return md(`Ahora estás operando como *${mine.business.name}*.`);
  }
  return md(MSG_UNKNOWN);
}

// ---------------- internos ----------------

interface ProceedOpts {
  freshStart: boolean;
}

async function handleCommand(
  deps: FlowDeps,
  tenant: TenantContext,
  resolution: ResolutionInfo,
  text: string,
  firstName: string | undefined,
  now: Date,
  reminder: boolean
): Promise<BotReply> {
  const name = text.slice(1).split(/\s+/)[0].toLowerCase().split('@')[0];

  if (name === 'cancelar') {
    await deps.conversations.clear(tenant.business.id, resolution.user.id);
    return md('Conversación cancelada. No se guardó nada.');
  }
  if (name === 'start' || name === 'menu' || name === 'ayuda') {
    return {
      ...md(`${deps.template.welcome(tenant.business.name, firstName)}${reminder ? '\n\n⚠️ _Recordá que tenés un pago pendiente._' : ''}`),
      inlineKeyboard: menuKeyboard(deps.template),
    };
  }
  if (name === 'invitar') {
    if (tenant.membership.role !== 'OWNER') {
      return md('Solo el dueño del negocio puede generar invitaciones.');
    }
    if (!deps.inviteBotUsername) {
      return md('Las invitaciones no están disponibles en este servidor.');
    }
    const arg = text.slice(1).split(/\s+/)[1]?.toLowerCase();
    const role = arg === 'dueno' || arg === 'dueño' ? 'OWNER' : 'EMPLOYEE';
    const created = await deps.invitations.create(tenant.business.id, role, {
      createdByUserId: resolution.user.id,
      ttlHours: 7 * 24,
      botUsername: deps.inviteBotUsername,
    });
    const whom = role === 'OWNER' ? 'tu socio' : 'tu empleado';
    return md(
      `Pasale este enlace a ${whom} (vale 7 días, un solo uso):\n${created.deepLink}`
    );
  }
  if (name === 'negocios') {
    if (resolution.memberships.length <= 1) {
      return md(`Operás como *${tenant.business.name}*.`);
    }
    return {
      ...md('Elegí con qué negocio querés operar:'),
      inlineKeyboard: resolution.memberships.map((m) => [
        { text: `${m.business.name} (${roleLabel(m.role)})`, callbackData: `biz:${m.id}` },
      ]),
    };
  }

  const cmd = deps.template.commands.find((c) => c.command === name);
  if (!cmd) {
    return md('Ese comando no existe. Tocá /ayuda para ver el menú.');
  }
  if (cmd.action) {
    const action = deps.template.actions.find((a) => a.name === cmd.action);
    if (!action) return md(MSG_UNKNOWN);
    return startAction(deps, tenant, resolution.user.id, action, {}, now, evaluateAccess(tenant.business, now), true);
  }
  return md(cmd.reply ?? MSG_UNKNOWN);
}

function roleLabel(role: string): string {
  return role === 'OWNER' ? 'dueño' : 'empleado';
}

async function startAction(
  deps: FlowDeps,
  tenant: TenantContext,
  userId: string,
  action: ActionDef<unknown>,
  initialData: Record<string, unknown>,
  now: Date,
  access: ReturnType<typeof evaluateAccess>,
  fromMenu: boolean
): Promise<BotReply> {
  const roleError = checkRole(tenant, action);
  if (roleError) return md(roleError);
  if (action.kind === 'write' && !access.canWrite) {
    return md(MSG_READONLY_WRITE);
  }
  const missing = missingFields(action.input, initialData);
  if (missing.length === 0) {
    if (action.kind === 'write') {
      return enterConfirming(deps, tenant, userId, action, initialData, now);
    }
    return executeAction(deps, tenant, userId, action, initialData, now, access);
  }
  await deps.conversations.upsert({
    businessId: tenant.business.id,
    userId,
    phase: 'COLLECTING',
    actionName: action.name,
    data: initialData,
    expiresAt: new Date(now.getTime() + (deps.conversationTtlMs ?? 10 * 60_000)),
    updatedAt: now,
  });
  if (fromMenu && action.intro) {
    return md(action.intro);
  }
  return md(askForField(action, missing[0]));
}

async function proceedWithAction(
  deps: FlowDeps,
  tenant: TenantContext,
  userId: string,
  action: ActionDef<unknown>,
  data: Record<string, unknown>,
  now: Date,
  access: ReturnType<typeof evaluateAccess>,
  opts: ProceedOpts
): Promise<BotReply> {
  const roleError = checkRole(tenant, action);
  if (roleError) return md(roleError);
  if (action.kind === 'write' && !access.canWrite) {
    await deps.conversations.clear(tenant.business.id, userId);
    return md(MSG_READONLY_WRITE);
  }
  const validation = action.input.safeParse(data);
  if (validation.success) {
    if (action.kind === 'write') {
      return enterConfirming(deps, tenant, userId, action, validation.data, now);
    }
    return executeAction(deps, tenant, userId, action, validation.data, now, access);
  }
  const missing = missingFields(action.input, data);
  await deps.conversations.upsert({
    businessId: tenant.business.id,
    userId,
    phase: 'COLLECTING',
    actionName: action.name,
    data,
    expiresAt: new Date(now.getTime() + (deps.conversationTtlMs ?? 10 * 60_000)),
    updatedAt: now,
  });
  if (missing.length > 0) {
    if (opts.freshStart && action.intro) {
      return md(action.intro);
    }
    return md(askForField(action, missing[0]));
  }
  // Error de validación que no es campo faltante: explicar el primer problema.
  const first = validation.error.issues[0];
  const where = first.path.length > 0 ? ` en "${String(first.path[0])}"` : '';
  return md(`Hay un problema con ese dato${where}: ${first.message}. ¿Lo repetís?`);
}

function checkRole(tenant: TenantContext, action: ActionDef<unknown>): string | null {
  const allowed = action.roles ?? ['OWNER', 'EMPLOYEE'];
  if (!allowed.includes(tenant.membership.role)) {
    return 'Solo el dueño del negocio puede hacer esto.';
  }
  return null;
}

async function enterConfirming(
  deps: FlowDeps,
  tenant: TenantContext,
  userId: string,
  action: ActionDef<unknown>,
  data: unknown,
  now: Date
): Promise<BotReply> {
  await deps.conversations.upsert({
    businessId: tenant.business.id,
    userId,
    phase: 'CONFIRMING',
    actionName: action.name,
    data: (data ?? {}) as Record<string, unknown>,
    expiresAt: new Date(now.getTime() + (deps.conversationTtlMs ?? 10 * 60_000)),
    updatedAt: now,
  });
  const summary = action.summarize ? action.summarize(data) : 'Revisá los datos.';
  return { ...md(`${summary}\n\n¿Confirmar?`), inlineKeyboard: confirmKeyboard() };
}

async function confirmPending(
  deps: FlowDeps,
  tenant: TenantContext,
  userId: string,
  now: Date,
  access: ReturnType<typeof evaluateAccess>
): Promise<BotReply> {
  const pending = await getActiveConversation(deps, tenant, userId, now);
  if (!pending || pending.phase !== 'CONFIRMING' || !pending.actionName) {
    return md('No hay ninguna operación pendiente de confirmación.');
  }
  const action = deps.template.actions.find((a) => a.name === pending.actionName);
  if (!action) {
    await deps.conversations.clear(tenant.business.id, userId);
    return md(MSG_UNKNOWN);
  }
  const roleError = checkRole(tenant, action);
  if (roleError) {
    await deps.conversations.clear(tenant.business.id, userId);
    return md(roleError);
  }
  if (action.kind === 'write' && !access.canWrite) {
    await deps.conversations.clear(tenant.business.id, userId);
    return md(MSG_READONLY_WRITE);
  }
  const validation = action.input.safeParse(pending.data);
  if (!validation.success) {
    await deps.conversations.clear(tenant.business.id, userId);
    return md('Los datos pendientes ya no son válidos. Empecemos de nuevo.');
  }
  return executeAction(deps, tenant, userId, action, validation.data, now, access);
}

async function executeAction(
  deps: FlowDeps,
  tenant: TenantContext,
  userId: string,
  action: ActionDef<unknown>,
  input: unknown,
  now: Date,
  access: ReturnType<typeof evaluateAccess>
): Promise<BotReply> {
  // El trial lo inicia la primera escritura real de negocio.
  if (action.kind === 'write' && shouldStartTrial(tenant.business)) {
    await deps.businesses.markTrialStarted(tenant.business.id, now);
  }
  await deps.membershipRepo.touchLastUsed(tenant.membership.id, now);
  const ctx: ActionContext = { tenant, actorUserId: userId, now };
  const result = await action.handler(ctx, input);
  if (action.kind === 'write' || result.audit) {
    await deps.audit.log({
      businessId: tenant.business.id,
      actorUserId: userId,
      action: result.audit?.action ?? `action.${action.name}`,
      entityType: result.audit?.entityType ?? null,
      entityId: result.audit?.entityId ?? null,
      metadata: result.audit?.metadata ?? {},
    });
  }
  await deps.conversations.clear(tenant.business.id, userId);
  const suffix = access.subscriptionReminder ? '\n\n⚠️ _Recordá que tenés un pago pendiente._' : '';
  return md(`${result.reply}${suffix}`);
}

async function getActiveConversation(
  deps: FlowDeps,
  tenant: TenantContext,
  userId: string,
  now: Date
) {
  const conv = await deps.conversations.get(tenant.business.id, userId);
  if (!conv || conv.phase === 'IDLE' || !conv.actionName) return null;
  if (conv.expiresAt && conv.expiresAt.getTime() <= now.getTime()) {
    await deps.conversations.clear(tenant.business.id, userId);
    return null;
  }
  return conv;
}

function mergeData(base: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Campos requeridos por el schema que aún no tienen valor. Soporta paths
 * anidados (ej. items con cantidad faltante → reporta la hoja "cantidad").
 */
export function missingFields(input: z.ZodType<unknown>, data: unknown): string[] {
  const result = input.safeParse(data);
  if (result.success) return [];
  const missing = new Set<string>();
  for (const issue of result.error.issues) {
    if (issue.path.length === 0) continue;
    const leaf = String(issue.path[issue.path.length - 1]);
    const isMissing =
      (issue.code === 'invalid_type' && (issue as { received?: unknown }).received === 'undefined') ||
      (issue.code === 'too_small' && issue.path.length > 0);
    if (!isMissing) continue;
    // Índices numéricos (items.0.cantidad) → pedir por la hoja.
    missing.add(/^\d+$/.test(leaf) ? String(issue.path.slice(0, -1).join('.')) || leaf : leaf);
  }
  return [...missing];
}

function askForField(action: ActionDef<unknown>, field: string): string {
  return action.fieldPrompts?.[field] ?? `Me falta el dato "${field}". ¿Me lo pasás?`;
}

async function enforceAiBudget(deps: FlowDeps, businessId: string, now: Date): Promise<void> {
  const limit = deps.aiDailyLimitPerBusiness ?? 200;
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const used = await deps.aiUsage.countByBusinessSince(businessId, startOfDay);
  if (used >= limit) {
    throw new AppError('Límite diario de inteligencia artificial alcanzado. Probá mañana.', 'AI_BUDGET_EXCEEDED', 429);
  }
}

async function maybePersistStatus(
  deps: FlowDeps,
  tenant: TenantContext,
  effective: TenantContext['business']['status']
): Promise<void> {
  if (effective !== tenant.business.status) {
    await deps.businesses.setStatus(tenant.business.id, effective);
    tenant.business.status = effective;
  }
}
