import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../errors/errors.js';
import type { Invitation, MembershipRole } from '../tenant/entities.js';
import type { IAuditRepository, IInvitationRepository } from '../persistence/repositories.js';

export interface CreatedInvitation {
  invitation: Invitation;
  /** Token en claro. Se muestra UNA vez (deep link). Nunca se guarda. */
  token: string;
  deepLink: string;
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

export class InvitationService {
  constructor(
    private readonly invitations: IInvitationRepository,
    private readonly audit: IAuditRepository,
    private readonly defaultTtlHours = 72
  ) {}

  async create(
    businessId: string,
    role: MembershipRole,
    opts: { createdByUserId?: string | null; ttlHours?: number; botUsername: string }
  ): Promise<CreatedInvitation> {
    const token = generateInvitationToken();
    const expiresAt = new Date(Date.now() + (opts.ttlHours ?? this.defaultTtlHours) * 3_600_000);
    const invitation = await this.invitations.create({
      businessId,
      role,
      tokenHash: hashInvitationToken(token),
      expiresAt,
      createdByUserId: opts.createdByUserId ?? null,
    });
    await this.audit.log({
      businessId,
      actorUserId: opts.createdByUserId ?? null,
      action: 'invitation.created',
      entityType: 'invitation',
      entityId: invitation.id,
      metadata: { role },
    });
    return {
      invitation,
      token,
      deepLink: `https://t.me/${opts.botUsername}?start=${token}`,
    };
  }

  /** Invitaciones del negocio (para la web admin y reportes). */
  async listByBusiness(businessId: string): Promise<Invitation[]> {
    return this.invitations.listByBusiness(businessId);
  }

  /** Valida y consume (un solo uso). Lanza si expiró, ya se usó o fue revocada. */  async consume(token: string, userId: string, now: Date = new Date()): Promise<Invitation> {
    const invitation = await this.invitations.findByHash(hashInvitationToken(token));
    if (!invitation) {
      throw new AppError('Invitación inválida.', 'INVALID_INVITATION', 404);
    }
    if (invitation.revokedAt) {
      throw new AppError('Esta invitación fue revocada.', 'INVITATION_REVOKED', 410);
    }
    if (invitation.usedAt) {
      throw new AppError('Esta invitación ya fue utilizada.', 'INVITATION_USED', 410);
    }
    if (invitation.expiresAt.getTime() <= now.getTime()) {
      throw new AppError('Esta invitación expiró.', 'INVITATION_EXPIRED', 410);
    }
    await this.invitations.markUsed(invitation.id, userId, now);
    await this.audit.log({
      businessId: invitation.businessId,
      actorUserId: userId,
      action: 'invitation.consumed',
      entityType: 'invitation',
      entityId: invitation.id,
      metadata: {},
    });
    return { ...invitation, usedAt: now, usedByUserId: userId };
  }

  async revoke(businessId: string, invitationId: string, actorUserId: string): Promise<void> {
    const invitation = await this.invitations.findById(invitationId);
    if (!invitation || invitation.businessId !== businessId) {
      throw new AppError('Invitación no encontrada.', 'INVALID_INVITATION', 404);
    }
    await this.invitations.revoke(invitationId, new Date());
    await this.audit.log({
      businessId,
      actorUserId,
      action: 'invitation.revoked',
      entityType: 'invitation',
      entityId: invitationId,
      metadata: {},
    });
  }
}
