import type {
  Business as PrismaBusiness,
  Invitation as PrismaInvitation,
  Membership as PrismaMembership,
  User as PrismaUser,
  ConversationState as PrismaConversation,
  AuditLog as PrismaAuditLog,
} from '@prisma/client';
import type {
  Business,
  ConversationState,
  Invitation,
  Membership,
  MembershipWithBusiness,
  User,
  AuditEntry,
} from '../../core/tenant/entities.js';

export function toUser(row: PrismaUser): User {
  return { id: row.id, telegramId: row.telegramId, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export function toBusiness(row: PrismaBusiness): Business {
  return {
    id: row.id,
    name: row.name,
    templateId: row.templateId,
    status: row.status,
    trialStartedAt: row.trialStartedAt,
    trialDays: row.trialDays,
    activatedAt: row.activatedAt,
    subscriptionExpiresAt: row.subscriptionExpiresAt,
    graceDays: row.graceDays,
    timezone: row.timezone,
    currency: row.currency,
    config: (row.config ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toMembership(row: PrismaMembership): Membership {
  return {
    id: row.id,
    businessId: row.businessId,
    userId: row.userId,
    role: row.role,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toMembershipWithBusiness(
  row: PrismaMembership & { business: PrismaBusiness }
): MembershipWithBusiness {
  return { ...toMembership(row), business: toBusiness(row.business) };
}

export function toInvitation(row: PrismaInvitation): Invitation {
  return {
    id: row.id,
    businessId: row.businessId,
    role: row.role,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    usedByUserId: row.usedByUserId,
    revokedAt: row.revokedAt,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  };
}

export function toConversation(row: PrismaConversation): ConversationState {
  return {
    businessId: row.businessId,
    userId: row.userId,
    phase: row.phase,
    actionName: row.actionName,
    data: (row.data ?? {}) as Record<string, unknown>,
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
  };
}

export function toAuditEntry(row: PrismaAuditLog): AuditEntry {
  return {
    id: row.id,
    businessId: row.businessId,
    actorUserId: row.actorUserId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}
