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
  IUserRepository,
  CreateBusinessData,
} from '../src/core/persistence/repositories.js';
import type {
  AuditEntry,
  Business,
  BusinessStatus,
  ConversationState,
  Invitation,
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
    if (b) b.status = status;
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
}

export class FakeAiUsageRepo implements IAiUsageRepository {
  count = 0;
  async log(_entry: ILogAiUsageData) {
    this.count += 1;
  }
  async countByBusinessSince(_businessId: string, _since: Date) {
    return this.count;
  }
}
