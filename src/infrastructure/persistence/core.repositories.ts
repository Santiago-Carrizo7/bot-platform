import type { Prisma, PrismaClient } from '@prisma/client';

/** Prisma exige InputJsonValue; nuestros contratos usan Record<string, unknown>. */
function toJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}
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
  IMembershipRepository,
  IUserRepository,
  CreateBusinessData,
} from '../../core/persistence/repositories.js';
import type {
  AuditEntry,
  Business,
  BusinessStatus,
  ConversationState,
  Invitation,
  Membership,
  MembershipWithBusiness,
  User,
} from '../../core/tenant/entities.js';
import {
  toAuditEntry,
  toBusiness,
  toConversation,
  toInvitation,
  toMembership,
  toMembershipWithBusiness,
  toUser,
} from './mappers.js';

export class PrismaUserRepository implements IUserRepository {
  constructor(private readonly db: PrismaClient) {}
  async findByTelegramId(telegramId: string): Promise<User | null> {
    const row = await this.db.user.findUnique({ where: { telegramId } });
    return row ? toUser(row) : null;
  }
  async findById(id: string): Promise<User | null> {
    const row = await this.db.user.findUnique({ where: { id } });
    return row ? toUser(row) : null;
  }
  async create(telegramId: string): Promise<User> {
    return toUser(await this.db.user.create({ data: { telegramId } }));
  }
}

export class PrismaBusinessRepository implements IBusinessRepository {
  constructor(private readonly db: PrismaClient) {}
  async findById(id: string): Promise<Business | null> {
    const row = await this.db.business.findUnique({ where: { id } });
    return row ? toBusiness(row) : null;
  }
  async create(data: CreateBusinessData): Promise<Business> {
    return toBusiness(
      await this.db.business.create({
        data: {
          name: data.name,
          templateId: data.templateId,
          trialDays: data.trialDays,
          graceDays: data.graceDays,
          timezone: data.timezone,
          currency: data.currency,
        },
      })
    );
  }
  async markTrialStarted(id: string, at: Date): Promise<void> {
    await this.db.business.update({ where: { id }, data: { trialStartedAt: at } });
  }
  async setStatus(id: string, status: BusinessStatus): Promise<void> {
    await this.db.business.update({ where: { id }, data: { status } });
  }
}

export class PrismaMembershipRepository implements IMembershipRepository {
  constructor(private readonly db: PrismaClient) {}
  async findByUserAndBusiness(userId: string, businessId: string): Promise<Membership | null> {
    const row = await this.db.membership.findUnique({ where: { businessId_userId: { businessId, userId } } });
    return row ? toMembership(row) : null;
  }
  async findByUserWithBusiness(userId: string): Promise<MembershipWithBusiness[]> {
    const rows = await this.db.membership.findMany({ where: { userId }, include: { business: true } });
    return rows.map(toMembershipWithBusiness);
  }
  async findByBusiness(businessId: string): Promise<Membership[]> {
    const rows = await this.db.membership.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toMembership);
  }
  async create(data: ICreateMembershipData): Promise<Membership> {
    return toMembership(await this.db.membership.create({ data }));
  }
  async touchLastUsed(id: string, at: Date): Promise<void> {
    await this.db.membership.update({ where: { id }, data: { lastUsedAt: at } });
  }
  async remove(id: string): Promise<void> {
    await this.db.membership.delete({ where: { id } });
  }
}

export class PrismaInvitationRepository implements IInvitationRepository {
  constructor(private readonly db: PrismaClient) {}
  async create(data: ICreateInvitationData): Promise<Invitation> {
    return toInvitation(await this.db.invitation.create({ data }));
  }
  async findByHash(tokenHash: string): Promise<Invitation | null> {
    const row = await this.db.invitation.findUnique({ where: { tokenHash } });
    return row ? toInvitation(row) : null;
  }
  async findById(id: string): Promise<Invitation | null> {
    const row = await this.db.invitation.findUnique({ where: { id } });
    return row ? toInvitation(row) : null;
  }
  async markUsed(id: string, userId: string, at: Date): Promise<void> {
    await this.db.invitation.update({ where: { id }, data: { usedAt: at, usedByUserId: userId } });
  }
  async revoke(id: string, at: Date): Promise<void> {
    await this.db.invitation.update({ where: { id }, data: { revokedAt: at } });
  }
  async listByBusiness(businessId: string): Promise<Invitation[]> {
    const rows = await this.db.invitation.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' } });
    return rows.map(toInvitation);
  }
}

export class PrismaConversationRepository implements IConversationRepository {
  constructor(private readonly db: PrismaClient) {}
  async get(businessId: string, userId: string): Promise<ConversationState | null> {
    const row = await this.db.conversationState.findUnique({ where: { businessId_userId: { businessId, userId } } });
    return row ? toConversation(row) : null;
  }
  async upsert(state: ConversationState): Promise<void> {
    await this.db.conversationState.upsert({
      where: { businessId_userId: { businessId: state.businessId, userId: state.userId } },
      create: {
        businessId: state.businessId,
        userId: state.userId,
        phase: state.phase,
        actionName: state.actionName,
        data: toJson(state.data),
        expiresAt: state.expiresAt,
      },
      update: {
        phase: state.phase,
        actionName: state.actionName,
        data: toJson(state.data),
        expiresAt: state.expiresAt,
      },
    });
  }
  async clear(businessId: string, userId: string): Promise<void> {
    await this.db.conversationState.deleteMany({ where: { businessId, userId } });
  }
}

export class PrismaAuditRepository implements IAuditRepository {
  constructor(private readonly db: PrismaClient) {}
  async log(entry: ILogAuditData): Promise<AuditEntry> {
    return toAuditEntry(
      await this.db.auditLog.create({
        data: {
          businessId: entry.businessId,
          actorUserId: entry.actorUserId ?? null,
          action: entry.action,
          entityType: entry.entityType ?? null,
          entityId: entry.entityId ?? null,
          metadata: toJson(entry.metadata ?? {}),
        },
      })
    );
  }
  async listByBusiness(businessId: string, limit = 50): Promise<AuditEntry[]> {
    const rows = await this.db.auditLog.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toAuditEntry);
  }
}

export class PrismaAiUsageRepository implements IAiUsageRepository {
  constructor(private readonly db: PrismaClient) {}
  async log(entry: ILogAiUsageData): Promise<void> {
    await this.db.aiUsageLog.create({
      data: { businessId: entry.businessId, userId: entry.userId ?? null, provider: entry.provider, model: entry.model },
    });
  }
  async countByBusinessSince(businessId: string, since: Date): Promise<number> {
    return this.db.aiUsageLog.count({ where: { businessId, createdAt: { gte: since } } });
  }
}
