/**
 * Entidades de Core. Tipos propios (no Prisma): core no conoce el ORM.
 * La capa de persistencia mapea Prisma <-> estos tipos.
 */

export type BusinessStatus = 'TRIAL' | 'ACTIVE' | 'READ_ONLY' | 'SUSPENDED';
export type MembershipRole = 'OWNER' | 'EMPLOYEE';
export type ConversationPhase = 'IDLE' | 'COLLECTING' | 'CONFIRMING';

export interface Business {
  id: string;
  name: string;
  templateId: string;
  status: BusinessStatus;
  trialStartedAt: Date | null;
  trialDays: number;
  activatedAt: Date | null;
  subscriptionExpiresAt: Date | null;
  graceDays: number;
  timezone: string;
  currency: string;
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface User {
  id: string;
  telegramId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Membership {
  id: string;
  businessId: string;
  userId: string;
  role: MembershipRole;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MembershipWithBusiness extends Membership {
  business: Business;
}

export interface Invitation {
  id: string;
  businessId: string;
  role: MembershipRole;
  /** Hash SHA-256 del token. El token en claro solo se muestra al crearlo. */
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  usedByUserId: string | null;
  revokedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface ConversationState {
  businessId: string;
  userId: string;
  phase: ConversationPhase;
  actionName: string | null;
  data: Record<string, unknown>;
  expiresAt: Date | null;
  updatedAt: Date;
}

export interface AuditEntry {
  id: string;
  businessId: string;
  actorUserId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface TenantContext {
  business: Business;
  membership: Membership;
  user: User;
  /** Template del bot que recibió el update (un bot = un template). */
  botTemplateId: string;
}
