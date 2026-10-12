/** Fakes en memoria para los contratos de persistencia de Core. */
import type {
  IAiUsageRepository,
  IAuditRepository,
  IBusinessRepository,
  IConversationRepository,
  ICreateInvitationData,
  ICreateMembershipData,
  IInvitationRepository,
  ILogAiUsageData,
  ILogAuditData,
  IPaymentRepository,
  IUserRepository,
  CreateBusinessData,
  CreateManualPaymentData,
} from '../src/core/persistence/repositories.js';
import type {
  AuditEntry,
  Business,
  BusinessStatus,
  ConversationState,
  Invitation,
  ManualPayment,
  Membership,
  MembershipWithBusiness,
  User,
} from '../src/core/tenant/entities.js';

let seq = 0;
const nid = (p: string) => `${p}-${++seq}-${Date.now().toString(36)}`;

export function makeBusiness(over: Partial<Business> = {}): Business {
  return {
    id: nid('biz'),
    name: 'Negocio Test',
    templateId: 'gastos',
    status: 'TRIAL',
    trialStartedAt: null,
    trialDays: 10,
    activatedAt: null,
    subscriptionExpiresAt: null,
    graceDays: 7,
    timezone: 'America/Argentina/Buenos_Aires',
    currency: 'ARS',
    config: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

export function makeUser(over: Partial<User> = {}): User {
  return { id: nid('user'), telegramId: '123456', createdAt: new Date(), updatedAt: new Date(), ...over };
}

export class FakeBusinessRepo implements IBusinessRepository {
  readonly store = new Map<string, Business>();
  async findById(id: string) {
    return this.store.get(id) ?? null;
  }
  async listAll() {
    return [...this.store.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async create(data: CreateBusinessData) {
    const b = makeBusiness({ ...data, id: nid('biz') });
    this.store.set(b.id, b);
    return b;
  }
  async markTrialStarted(id: string, at: Date) {
    const b = this.store.get(id);
    if (b) b.trialStartedAt = at;
  }
  async setStatus(id: string, status: BusinessStatus) {
    const b = this.store.get(id);
    // Copia, como Prisma: una referencia vieja no se entera del cambio.
    if (b) this.store.set(id, { ...b, status });
  }
  seed(b: Business) {
    this.store.set(b.id, b);
    return b;
  }
}

export class FakeUserRepo implements IUserRepository {
  readonly store = new Map<string, User>();
  async findByTelegramId(telegramId: string) {
    return [...this.store.values()].find((u) => u.telegramId === telegramId) ?? null;
  }
  async findById(id: string) {
    return this.store.get(id) ?? null;
  }
  async create(telegramId: string) {
    const u = makeUser({ id: nid('user'), telegramId });
    this.store.set(u.id, u);
    return u;
  }
}

export class FakeMembershipRepo implements import('../src/core/persistence/repositories.js').IMembershipRepository {
  readonly store = new Map<string, Membership>();
  constructor(private readonly businesses: FakeBusinessRepo) {}
  async findByUserAndBusiness(userId: string, businessId: string) {
    return [...this.store.values()].find((m) => m.userId === userId && m.businessId === businessId) ?? null;
  }
  async findByUserWithBusiness(userId: string): Promise<MembershipWithBusiness[]> {
    const out: MembershipWithBusiness[] = [];
    for (const m of this.store.values()) {
      if (m.userId !== userId) continue;
      const b = await this.businesses.findById(m.businessId);
      if (b) out.push({ ...m, business: b });
    }
    return out;
  }
  async findByBusiness(businessId: string) {
    return [...this.store.values()].filter((m) => m.businessId === businessId);
  }
  async create(data: ICreateMembershipData) {
    const m: Membership = {
      id: nid('mem'),
      businessId: data.businessId,
      userId: data.userId,
      role: data.role,
      lastUsedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.store.set(m.id, m);
    return m;
  }
  async touchLastUsed(id: string, at: Date) {
    const m = this.store.get(id);
    if (m) m.lastUsedAt = at;
  }
  async remove(id: string) {
    this.store.delete(id);
  }
}

export class FakeInvitationRepo implements IInvitationRepository {
  readonly store = new Map<string, Invitation>();
  async create(data: ICreateInvitationData) {
    const inv: Invitation = {
      id: nid('inv'),
      businessId: data.businessId,
      role: data.role,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
      usedAt: null,
      usedByUserId: null,
      revokedAt: null,
      createdByUserId: data.createdByUserId ?? null,
      createdAt: new Date(),
    };
    this.store.set(inv.id, inv);
    return inv;
  }
  async findByHash(tokenHash: string) {
    return [...this.store.values()].find((i) => i.tokenHash === tokenHash) ?? null;
  }
  async findById(id: string) {
    return this.store.get(id) ?? null;
  }
  async markUsed(id: string, userId: string, at: Date) {
    const inv = this.store.get(id);
    if (inv) {
      inv.usedAt = at;
      inv.usedByUserId = userId;
    }
  }
  async revoke(id: string, at: Date) {
    const inv = this.store.get(id);
    if (inv) inv.revokedAt = at;
  }
  async listByBusiness(businessId: string) {
    return [...this.store.values()].filter((i) => i.businessId === businessId);
  }
}

export class FakeConversationRepo implements IConversationRepository {
  readonly store = new Map<string, ConversationState>();
  private key(b: string, u: string) {
    return `${b}|${u}`;
  }
  async get(businessId: string, userId: string) {
    return this.store.get(this.key(businessId, userId)) ?? null;
  }
  async upsert(state: ConversationState) {
    this.store.set(this.key(state.businessId, state.userId), { ...state });
  }
  async clear(businessId: string, userId: string) {
    this.store.delete(this.key(businessId, userId));
  }
}

export class FakeAuditRepo implements IAuditRepository {
  readonly entries: AuditEntry[] = [];
  async log(entry: ILogAuditData) {
    const full: AuditEntry = {
      id: nid('audit'),
      businessId: entry.businessId,
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata ?? {},
      createdAt: new Date(),
    };
    this.entries.push(full);
    return full;
  }
  async listByBusiness(businessId: string, limit = 50) {
    return this.entries.filter((e) => e.businessId === businessId).slice(0, limit);
  }
  async listRecent(limit = 50) {
    return [...this.entries].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
  }
}

export class FakeAiUsageRepo implements IAiUsageRepository {
  count = 0;
  visionCount = 0;
  async log(entry: ILogAiUsageData) {
    this.count += 1;
    if (entry.provider.startsWith('vision') || entry.model.startsWith('vision')) {
      this.visionCount += 1;
    }
  }
  async countByBusinessSince(_businessId: string, _since: Date) {
    return this.count;
  }
  async countVisionByBusinessSince(_businessId: string, _since: Date) {
    return this.visionCount;
  }
}

export function makePayment(over: Partial<ManualPayment> = {}): ManualPayment {
  const now = new Date();
  return {
    id: nid('pay'),
    businessId: 'biz-1',
    amount: 15000,
    currency: 'ARS',
    paidAt: now,
    method: 'TRANSFERENCIA',
    periodFrom: null,
    periodTo: null,
    concept: 'Suscripción mensual',
    notes: null,
    operator: 'ops-1',
    status: 'CONFIRMED',
    idempotencyKey: nid('idem'),
    voidReason: null,
    voidAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

export class FakePaymentRepo implements IPaymentRepository {
  readonly store = new Map<string, ManualPayment>();
  async create(data: CreateManualPaymentData) {
    const p = makePayment({
      id: nid('pay'),
      businessId: data.businessId,
      amount: data.amount,
      currency: data.currency,
      paidAt: data.paidAt,
      method: data.method,
      periodFrom: data.periodFrom ?? null,
      periodTo: data.periodTo ?? null,
      concept: data.concept,
      notes: data.notes ?? null,
      operator: data.operator ?? null,
      status: data.status,
      idempotencyKey: data.idempotencyKey,
    });
    this.store.set(p.id, p);
    return p;
  }
  async findById(id: string) {
    return this.store.get(id) ?? null;
  }
  async findByIdempotency(businessId: string, idempotencyKey: string) {
    return [...this.store.values()].find((p) => p.businessId === businessId && p.idempotencyKey === idempotencyKey) ?? null;
  }
  async listByBusiness(businessId: string, limit = 100) {
    return [...this.store.values()]
      .filter((p) => p.businessId === businessId)
      .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime())
      .slice(0, limit);
  }
  async listRecent(limit = 50) {
    return [...this.store.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
  }
  async voidPayment(id: string, reason: string, at: Date = new Date()) {
    const p = this.store.get(id);
    if (!p) throw new Error('Pago no encontrado');
    const voided: ManualPayment = { ...p, status: 'VOID', voidReason: reason, voidAt: at, updatedAt: at };
    this.store.set(id, voided);
    return voided;
  }
  seed(p: ManualPayment) {
    this.store.set(p.id, p);
    return p;
  }
}
