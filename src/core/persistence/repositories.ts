/**
 * Contratos de persistencia de Core. Los servicios de core dependen de estas
 * interfaces; `infrastructure/persistence` las implementa con Prisma.
 * Los tests usan fakes en memoria que cumplen la misma forma.
 */
import type {
  AuditEntry,
  Business,
  BusinessStatus,
  ConversationState,
  Invitation,
  Membership,
  MembershipRole,
  MembershipWithBusiness,
} from '../tenant/entities.js';

export interface CreateBusinessData {
  name: string;
  templateId: string;
  trialDays?: number;
  graceDays?: number;
  timezone?: string;
  currency?: string;
}

export interface IBusinessRepository {
  findById(id: string): Promise<Business | null>;
  /** Todos los negocios (orden: más recientes primero). Solo la web admin interna. */
  listAll(): Promise<Business[]>;
  create(data: CreateBusinessData): Promise<Business>;
  markTrialStarted(id: string, at: Date): Promise<void>;
  setStatus(id: string, status: BusinessStatus): Promise<void>;
}

export interface IUserRepository {
  findByTelegramId(telegramId: string): Promise<import('../tenant/entities.js').User | null>;
  findById(id: string): Promise<import('../tenant/entities.js').User | null>;
  create(telegramId: string): Promise<import('../tenant/entities.js').User>;
}

export interface ICreateMembershipData {
  businessId: string;
  userId: string;
  role: MembershipRole;
}

export interface IMembershipRepository {
  findByUserAndBusiness(userId: string, businessId: string): Promise<Membership | null>;
  findByUserWithBusiness(userId: string): Promise<MembershipWithBusiness[]>;
  findByBusiness(businessId: string): Promise<Membership[]>;
  create(data: ICreateMembershipData): Promise<Membership>;
  touchLastUsed(id: string, at: Date): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface ICreateInvitationData {
  businessId: string;
  role: MembershipRole;
  tokenHash: string;
  expiresAt: Date;
  createdByUserId?: string | null;
}

export interface IInvitationRepository {
  create(data: ICreateInvitationData): Promise<Invitation>;
  findByHash(tokenHash: string): Promise<Invitation | null>;
  findById(id: string): Promise<Invitation | null>;
  markUsed(id: string, userId: string, at: Date): Promise<void>;
  revoke(id: string, at: Date): Promise<void>;
  listByBusiness(businessId: string): Promise<Invitation[]>;
}

export interface IConversationRepository {
  get(businessId: string, userId: string): Promise<ConversationState | null>;
  upsert(state: ConversationState): Promise<void>;
  clear(businessId: string, userId: string): Promise<void>;
}

export interface ILogAuditData {
  businessId: string;
  actorUserId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface IAuditRepository {
  log(entry: ILogAuditData): Promise<AuditEntry>;
  listByBusiness(businessId: string, limit?: number): Promise<AuditEntry[]>;
}

export interface ILogAiUsageData {
  businessId: string;
  userId?: string | null;
  provider: string;
  model: string;
}

export interface IAiUsageRepository {
  log(entry: ILogAiUsageData): Promise<void>;
  countByBusinessSince(businessId: string, since: Date): Promise<number>;
  countVisionByBusinessSince(businessId: string, since: Date): Promise<number>;
}
