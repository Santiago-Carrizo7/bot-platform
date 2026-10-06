import type { MembershipWithBusiness, TenantContext, User } from './entities.js';
import type { IMembershipRepository } from '../persistence/repositories.js';
import type { InvitationService } from '../identity/invitation.service.js';
import type { MembershipService } from '../identity/membership.service.js';
import type { UserService } from '../identity/user.service.js';

export interface ResolveRequest {
  telegramId: string;
  /** Template del bot que recibió el update. Solo resuelven negocios de ese template. */
  botTemplateId: string;
  /** Payload de `/start <TOKEN>` (deep link de invitación), si lo hay. */
  startPayload?: string;
  now?: Date;
}

export interface Resolution {
  user: User;
  tenant: TenantContext | null;
  /** true si en este update se creó la membership vía invitación. */
  justJoined: boolean;
  /** Membresías del usuario en negocios de este template (para /negocios). */
  memberships: MembershipWithBusiness[];
  needsInvitation: boolean;
}

/**
 * Resuelve quién habla y en nombre de qué negocio.
 * - Con startPayload válido: consume la invitación y crea la membership.
 * - Sin membership en negocios de este template: needsInvitation (salvo join).
 * - Con varias: usa la usada más recientemente (lastUsedAt); /negocios permite cambiar.
 */
export class TenantResolver {
  constructor(
    private readonly users: UserService,
    private readonly memberships: MembershipService,
    private readonly membershipRepo: IMembershipRepository,
    private readonly invitations: InvitationService
  ) {}

  async resolve(req: ResolveRequest): Promise<Resolution> {
    const now = req.now ?? new Date();
    const user = await this.users.getOrCreateByTelegramId(req.telegramId);

    if (req.startPayload) {
      const invitation = await this.invitations.consume(req.startPayload, user.id, now);
      const membership = await this.memberships.ensureMembership(
        invitation.businessId,
        user.id,
        invitation.role
      );
      await this.membershipRepo.touchLastUsed(membership.id, now);
      const all = await this.memberships.membershipsOfUser(user.id);
      const withBusiness = all.find((m) => m.businessId === invitation.businessId);
      if (!withBusiness) {
        throw new Error('Membership recién creada no encontrada (inconsistencia interna)');
      }
      return {
        user,
        tenant: this.toContext(withBusiness, user, req.botTemplateId),
        justJoined: true,
        memberships: this.forTemplate(all, req.botTemplateId),
        needsInvitation: false,
      };
    }

    const all = await this.memberships.membershipsOfUser(user.id);
    const scoped = this.forTemplate(all, req.botTemplateId);
    if (scoped.length === 0) {
      return { user, tenant: null, justJoined: false, memberships: [], needsInvitation: true };
    }
    const picked = [...scoped].sort((a, b) => {
      const ta = a.lastUsedAt?.getTime() ?? 0;
      const tb = b.lastUsedAt?.getTime() ?? 0;
      return tb - ta;
    })[0];
    return {
      user,
      tenant: this.toContext(picked, user, req.botTemplateId),
      justJoined: false,
      memberships: scoped,
      needsInvitation: false,
    };
  }

  private forTemplate(all: MembershipWithBusiness[], templateId: string): MembershipWithBusiness[] {
    return all.filter((m) => m.business.templateId === templateId);
  }

  private toContext(m: MembershipWithBusiness, user: User, botTemplateId: string): TenantContext {
    return { business: m.business, membership: m, user, botTemplateId };
  }
}
