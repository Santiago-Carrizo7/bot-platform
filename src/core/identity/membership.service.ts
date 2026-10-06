import { ForbiddenError, NotFoundError } from '../errors/errors.js';
import type { Membership, MembershipRole, MembershipWithBusiness } from '../tenant/entities.js';
import type { IMembershipRepository } from '../persistence/repositories.js';
import { roleSatisfies } from './roles.js';

export class MembershipService {
  constructor(private readonly memberships: IMembershipRepository) {}

  async ensureMembership(businessId: string, userId: string, role: MembershipRole): Promise<Membership> {
    const existing = await this.memberships.findByUserAndBusiness(userId, businessId);
    if (existing) return existing;
    return this.memberships.create({ businessId, userId, role });
  }

  async listByBusiness(businessId: string): Promise<Membership[]> {
    return this.memberships.findByBusiness(businessId);
  }

  async requireMembership(userId: string, businessId: string): Promise<Membership> {
    const membership = await this.memberships.findByUserAndBusiness(userId, businessId);
    if (!membership) {
      throw new ForbiddenError('No pertenecés a este negocio.');
    }
    return membership;
  }

  async requireRole(userId: string, businessId: string, role: MembershipRole): Promise<Membership> {
    const membership = await this.requireMembership(userId, businessId);
    if (!roleSatisfies(membership.role, role)) {
      throw new ForbiddenError('Solo el dueño del negocio puede hacer esto.');
    }
    return membership;
  }

  async removeMember(businessId: string, membershipId: string): Promise<void> {
    const members = await this.memberships.findByBusiness(businessId);
    const target = members.find((m) => m.id === membershipId);
    if (!target) {
      throw new NotFoundError('Miembro no encontrado en este negocio');
    }
    await this.memberships.remove(membershipId);
  }

  async membershipsOfUser(userId: string): Promise<MembershipWithBusiness[]> {
    return this.memberships.findByUserWithBusiness(userId);
  }
}
