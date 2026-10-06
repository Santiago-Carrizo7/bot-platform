import { describe, expect, it, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import {
  handleCallback,
  handleText,
  type FlowDeps,
  type ResolutionInfo,
} from '../src/core/messaging/flow.js';
import type { ActionDef, TemplateDefinition } from '../src/core/actions/registry.js';
import { ActionInterpreter } from '../src/core/ai/interpreter.js';
import { AuditService } from '../src/core/audit/audit.service.js';
import {
  FakeAiUsageRepo,
  FakeAuditRepo,
  FakeBusinessRepo,
  FakeConversationRepo,
  FakeInvitationRepo,
  FakeMembershipRepo,
  FakeUserRepo,
  makeBusiness,
} from './fakes.js';
import { InvitationService } from '../src/core/identity/invitation.service.js';
import type { TenantContext } from '../src/core/tenant/entities.js';

const NOW = new Date('2026-10-06T12:00:00Z');

let writeCalls = 0;

const readAction: ActionDef<{ month?: string }> = {
  name: 'consultar_total',
  description: 'Consulta el total del mes.',
  kind: 'read',
  input: z.object({ month: z.string().optional() }),
  handler: async () => ({ reply: 'Total: $ 5.000' }),
};

const writeAction: ActionDef<{ amount: number; description: string }> = {
  name: 'registrar_gasto',
  description: 'Registra un gasto con monto y descripción.',
  kind: 'write',
  input: z.object({ amount: z.number().positive(), description: z.string().min(1) }),
  intro: 'Para registrar necesito monto y descripción. Pasame todo junto.',
  fieldPrompts: { amount: '¿Cuál es el monto?', description: '¿En qué lo gastaste?' },
  summarize: (i) => `Entendí: gasto de ${i.amount} en ${i.description}`,
  handler: async () => {
    writeCalls += 1;
    return { reply: 'Guardado', audit: { action: 'gasto.creado' } };
  },
};

const ownerAction: ActionDef<Record<string, unknown>> = {
  name: 'accion_dueno',
  description: 'Solo dueño.',
  kind: 'read',
  roles: ['OWNER'],
  input: z.object({}),
  handler: async () => ({ reply: 'ok dueño' }),
};

const template: TemplateDefinition = {
  id: 'gastos',
  label: 'Gastos',
  welcome: () => 'Bienvenido al negocio',
  systemPrompt: () => 'sys',
  actions: [readAction, writeAction, ownerAction],
  commands: [
    { command: 'registrar', action: 'registrar_gasto' },
    { command: 'total', action: 'consultar_total' },
  ],
  menu: [{ label: 'Registrar gasto', action: 'registrar_gasto' }],
  replyMenu: [
    { label: '📦 Total', action: 'consultar_total' },
    { label: '➕ Gasto', action: 'registrar_gasto' },
  ],
};

/** Intérprete stub con respuestas encoladas. */
function stubInterpreter(queue: Array<{ action: string; params: Record<string, unknown> }>): ActionInterpreter {
  return {
    interpret: vi.fn(async (_sys: string, actions: ActionDef<unknown>[]) => {
      const next = queue.shift();
      if (!next) throw new Error('sin respuestas de IA');
      const action = actions.find((a) => a.name === next.action);
      if (!action) throw new Error('acción desconocida');
      return { action, params: next.params };
    }),
  } as unknown as ActionInterpreter;
}

interface Fixture {
  deps: FlowDeps;
  tenant: TenantContext;
  resolution: ResolutionInfo;
  conversations: FakeConversationRepo;
  audit: FakeAuditRepo;
  businesses: FakeBusinessRepo;
  invitations: FakeInvitationRepo;
}

function setup(opts: {
  role?: 'OWNER' | 'EMPLOYEE';
  status?: 'TRIAL' | 'ACTIVE' | 'READ_ONLY' | 'SUSPENDED';
  trialStartedAt?: Date | null;
  aiQueue?: Array<{ action: string; params: Record<string, unknown> }>;
  aiLimit?: number;
  aiUsed?: number;
  inviteBotUsername?: string;
} = {}): Fixture {
  const businesses = new FakeBusinessRepo();
  const users = new FakeUserRepo();
  const membershipRepo = new FakeMembershipRepo(businesses);
  const conversations = new FakeConversationRepo();
  const auditRepo = new FakeAuditRepo();
  const aiUsage = new FakeAiUsageRepo();

  const business = businesses.seed(
    makeBusiness({ status: opts.status ?? 'TRIAL', trialStartedAt: opts.trialStartedAt ?? null })
  );
  const user = { id: 'user-1', telegramId: 'tg-1', createdAt: NOW, updatedAt: NOW };
  users.store.set(user.id, user);
  const membership = {
    id: 'mem-1',
    businessId: business.id,
    userId: user.id,
    role: opts.role ?? 'EMPLOYEE',
    lastUsedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  membershipRepo.store.set(membership.id, membership);

  aiUsage.count = opts.aiUsed ?? 0;
  const invitations = new FakeInvitationRepo();
  const deps: FlowDeps = {
    template,
    interpreter: stubInterpreter(opts.aiQueue ?? []),
    conversations,
    businesses,
    membershipRepo,
    audit: new AuditService(auditRepo),
    invitations: new InvitationService(invitations, auditRepo),
    inviteBotUsername: opts.inviteBotUsername ?? 'mi_bot',
    aiUsage,
    aiProviderName: 'Mock',
    aiModel: 'mock-1',
    aiDailyLimitPerBusiness: opts.aiLimit,
  };
  const tenant: TenantContext = { business, membership, user, botTemplateId: 'gastos' };
  const resolution: ResolutionInfo = { user, tenant, justJoined: false, memberships: [], needsInvitation: false };
  return { deps, tenant, resolution, conversations, audit: auditRepo, businesses, invitations };
}

const text = (f: Fixture, t: string, now: Date = NOW) =>
  handleText(f.deps, { resolution: f.resolution, text: t, now });

describe('pipeline de mensajes', () => {
  beforeEach(() => {
    writeCalls = 0;
  });

  it('lectura por freestyle: ejecuta directo, sin confirmación ni auditoría', async () => {
    const f = setup({ aiQueue: [{ action: 'consultar_total', params: {} }] });
    const reply = await text(f, 'cuánto gasté este mes');
    expect(reply.text).toContain('Total: $ 5.000');
    expect(reply.inlineKeyboard).toBeUndefined();
    expect(f.audit.entries).toHaveLength(0);
    expect(writeCalls).toBe(0);
  });

  it('escritura por freestyle: pide confirmación y NO ejecuta todavía', async () => {
    const f = setup({ aiQueue: [{ action: 'registrar_gasto', params: { amount: 5000, description: 'Saeta' } }] });
    const reply = await text(f, 'gasté 5000 en Saeta');
    expect(reply.text).toContain('¿Confirmar?');
    expect(reply.text).toContain('5000');
    expect(reply.inlineKeyboard).toBeDefined();
    expect(writeCalls).toBe(0);
    const conv = await f.conversations.get(f.tenant.business.id, 'user-1');
    expect(conv?.phase).toBe('CONFIRMING');
  });

  it('confirm:yes ejecuta, audita con actor y limpia la conversación', async () => {
    const f = setup({ aiQueue: [{ action: 'registrar_gasto', params: { amount: 5000, description: 'Saeta' } }] });
    await text(f, 'gasté 5000 en Saeta');
    const reply = await handleCallback(f.deps, { resolution: f.resolution, data: 'confirm:yes', now: NOW });
    expect(reply.text).toContain('Guardado');
    expect(writeCalls).toBe(1);
    expect(f.audit.entries).toHaveLength(1);
    expect(f.audit.entries[0]).toMatchObject({ action: 'gasto.creado', actorUserId: 'user-1' });
    expect(await f.conversations.get(f.tenant.business.id, 'user-1')).toBeNull();
  });

  it('confirm:no cancela sin ejecutar ni auditar', async () => {
    const f = setup({ aiQueue: [{ action: 'registrar_gasto', params: { amount: 5000, description: 'Saeta' } }] });
    await text(f, 'gasté 5000 en Saeta');
    const reply = await handleCallback(f.deps, { resolution: f.resolution, data: 'confirm:no', now: NOW });
    expect(reply.text).toContain('Cancelado');
    expect(writeCalls).toBe(0);
    expect(f.audit.entries).toHaveLength(0);
  });

  it('texto "sí" durante la confirmación también confirma (flujo por audio)', async () => {
    const f = setup({ aiQueue: [{ action: 'registrar_gasto', params: { amount: 5000, description: 'Saeta' } }] });
    await text(f, 'gasté 5000 en Saeta');
    const reply = await text(f, 'sí');
    expect(reply.text).toContain('Guardado');
    expect(writeCalls).toBe(1);
  });

  it('dato faltante: pregunta el campo y completa en el siguiente mensaje', async () => {
    const f = setup({
      aiQueue: [
        { action: 'registrar_gasto', params: { description: 'Saeta' } },
        { action: 'registrar_gasto', params: { amount: 5000 } },
      ],
    });
    const ask = await text(f, 'gasté en Saeta');
    // Primer mensaje parcial: el intro invita a mandar todo junto.
    expect(ask.text).toContain('monto y descripción');
    expect(writeCalls).toBe(0);
    const confirm = await text(f, '5000');
    expect(confirm.text).toContain('¿Confirmar?');
    expect(confirm.text).toContain('Saeta');
    const done = await handleCallback(f.deps, { resolution: f.resolution, data: 'confirm:yes', now: NOW });
    expect(done.text).toContain('Guardado');
    expect(writeCalls).toBe(1);
  });

  it('/cancelar limpia la conversación pendiente', async () => {
    const f = setup({ aiQueue: [{ action: 'registrar_gasto', params: { description: 'Saeta' } }] });
    await text(f, 'gasté en Saeta');
    const reply = await text(f, '/cancelar');
    expect(reply.text).toContain('cancelada');
    expect(await f.conversations.get(f.tenant.business.id, 'user-1')).toBeNull();
  });

  it('READ_ONLY: bloquea escrituras pero permite lecturas', async () => {
    const f = setup({
      status: 'READ_ONLY',
      aiQueue: [
        { action: 'registrar_gasto', params: { amount: 1, description: 'x' } },
        { action: 'consultar_total', params: {} },
      ],
    });
    const blocked = await text(f, 'gasté 1 en x');
    expect(blocked.text).toContain('solo lectura');
    expect(writeCalls).toBe(0);
    const ok = await text(f, 'cuánto gasté');
    expect(ok.text).toContain('Total:');
  });

  it('la primera escritura inicia el trial (las lecturas no)', async () => {
    const f = setup({ aiQueue: [{ action: 'registrar_gasto', params: { amount: 1, description: 'x' } }] });
    expect(f.tenant.business.trialStartedAt).toBeNull();
    await text(f, 'gasté 1 en x');
    await handleCallback(f.deps, { resolution: f.resolution, data: 'confirm:yes', now: NOW });
    expect(f.tenant.business.trialStartedAt).toEqual(NOW);
  });

  it('EMPLEADO no puede ejecutar acción de OWNER', async () => {
    const f = setup({ role: 'EMPLOYEE', aiQueue: [{ action: 'accion_dueno', params: {} }] });
    const reply = await text(f, 'hacer cosa de dueño');
    expect(reply.text).toContain('dueño');
  });

  it('OWNER sí puede ejecutar acción de OWNER', async () => {
    const f = setup({ role: 'OWNER', aiQueue: [{ action: 'accion_dueno', params: {} }] });
    const reply = await text(f, 'hacer cosa de dueño');
    expect(reply.text).toContain('ok dueño');
  });

  it('botón de menú inicia la acción con su intro', async () => {
    const f = setup({});
    const reply = await handleCallback(f.deps, { resolution: f.resolution, data: 'menu:registrar_gasto', now: NOW });
    expect(reply.text).toContain('monto y descripción');
    const conv = await f.conversations.get(f.tenant.business.id, 'user-1');
    expect(conv?.phase).toBe('COLLECTING');
  });

  it('/start muestra bienvenida y /negocios no existe como comando fantasma', async () => {
    const f = setup({});
    const start = await text(f, '/start');
    expect(start.text).toContain('Bienvenido');
    const unknown = await text(f, '/inexistente');
    expect(unknown.text).toContain('no existe');
  });

  it('sin tenant: pide invitación', async () => {
    const f = setup({});
    const noTenant: ResolutionInfo = { ...f.resolution, tenant: null, needsInvitation: true };
    const reply = await handleText(f.deps, { resolution: noTenant, text: 'hola', now: NOW });
    expect(reply.text).toContain('invitación');
  });

  it('suspendido: bloquea todo', async () => {
    const f = setup({ status: 'SUSPENDED', aiQueue: [{ action: 'consultar_total', params: {} }] });
    const reply = await text(f, 'hola');
    expect(reply.text).toContain('suspendido');
  });

  it('cupo diario de IA excedido: no llama al modelo', async () => {
    const f = setup({ aiLimit: 5, aiUsed: 5, aiQueue: [{ action: 'consultar_total', params: {} }] });
    await expect(text(f, 'hola')).rejects.toThrow(/Límite diario/);
  });

  it('tap en botón de la barra (lectura): ejecuta sin llamar a la IA', async () => {
    const f = setup({ aiQueue: [{ action: 'consultar_total', params: {} }] });
    const reply = await text(f, '📦 Total');
    expect(reply.text).toContain('Total: $ 5.000');
    expect(f.deps.interpreter.interpret).not.toHaveBeenCalled();
    expect(writeCalls).toBe(0);
  });

  it('tap en botón de la barra (escritura): abre la conversación con el intro', async () => {
    const f = setup({ aiQueue: [{ action: 'registrar_gasto', params: {} }] });
    const reply = await text(f, '➕ Gasto');
    expect(reply.text).toContain('Para registrar necesito monto y descripción');
    expect(f.deps.interpreter.interpret).not.toHaveBeenCalled();
    const conv = await f.conversations.get(f.tenant.business.id, 'user-1');
    expect(conv?.phase).toBe('COLLECTING');
    expect(conv?.actionName).toBe('registrar_gasto');
  });

  it('tap en otro botón durante la confirmación: abandona y cambia de acción', async () => {
    const f = setup({ aiQueue: [{ action: 'registrar_gasto', params: { amount: 5000, description: 'Saeta' } }] });
    const pending = await text(f, 'gasté 5000 en Saeta');
    expect(pending.text).toContain('¿Confirmar?');
    const reply = await text(f, '📦 Total');
    expect(reply.text).toContain('Total: $ 5.000');
    expect(writeCalls).toBe(0);
  });

  it('/invitar como OWNER: devuelve deep link de empleado válido 7 días', async () => {
    const f = setup({ role: 'OWNER' });
    const reply = await text(f, '/invitar');
    expect(reply.text).toContain('https://t.me/mi_bot?start=');
    expect(reply.text).toContain('7 días');
    const stored = [...f.invitations.store.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ role: 'EMPLOYEE', businessId: f.tenant.business.id });
    expect(f.deps.interpreter.interpret).not.toHaveBeenCalled();
  });

  it('/invitar dueno: genera invitación de OWNER', async () => {
    const f = setup({ role: 'OWNER' });
    const reply = await text(f, '/invitar dueno');
    expect(reply.text).toContain('https://t.me/mi_bot?start=');
    expect(reply.text).toContain('socio');
    expect([...f.invitations.store.values()][0]).toMatchObject({ role: 'OWNER' });
  });

  it('/invitar como EMPLOYEE: denegado sin crear nada', async () => {
    const f = setup({ role: 'EMPLOYEE' });
    const reply = await text(f, '/invitar');
    expect(reply.text).toContain('Solo el dueño');
    expect(f.invitations.store.size).toBe(0);
  });

  it('/invitar sin username configurado: mensaje claro en vez de link roto', async () => {
    const f = setup({ role: 'OWNER' });
    delete f.deps.inviteBotUsername;
    const reply = await text(f, '/invitar');
    expect(reply.text).toContain('no están disponibles');
    expect(f.invitations.store.size).toBe(0);
  });

  it('registry: escritura sin summarize y nombres duplicados fallan en construcción', async () => {
    const { ActionRegistry } = await import('../src/core/actions/registry.js');
    expect(
      () =>
        new ActionRegistry([
          { ...writeAction, summarize: undefined } as unknown as ActionDef<unknown>,
        ])
    ).toThrow(/summarize/);
    expect(() => new ActionRegistry([readAction, readAction])).toThrow(/duplicada/);
  });
});
