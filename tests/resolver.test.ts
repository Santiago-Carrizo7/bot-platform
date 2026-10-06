import { describe, expect, it } from 'vitest';
import { TenantResolver } from '../src/core/tenant/resolver.js';
import { UserService } from '../src/core/identity/user.service.js';
import { MembershipService } from '../src/core/identity/membership.service.js';
import { InvitationService } from '../src/core/identity/invitation.service.js';
import { AuditService } from '../src/core/audit/audit.service.js';
import { FakeAuditRepo, FakeBusinessRepo, FakeInvitationRepo, FakeMembershipRepo, FakeUserRepo, makeBusiness } from './fakes.js';

function setup() {
  const businesses = new FakeBusinessRepo();
  const users = new FakeUserRepo();
  const membershipRepo = new FakeMembershipRepo(businesses);
  const audit = new AuditService(new FakeAuditRepo());
  const userService = new UserService(users);
  const membershipService = new MembershipService(membershipRepo);
  const invitationService = new InvitationService(new FakeInvitationRepo(), audit);
  const resolver = new TenantResolver(userService, membershipService, membershipRepo, invitationService);
  return { resolver, businesses, users, membershipRepo, invitationService };
}

describe('TenantResolver', () => {
  it('sin membership: needsInvitation', async () => {
    const { resolver, businesses } = setup();
    businesses.seed(makeBusiness({ id: 'biz-1' }));
    const r = await resolver.resolve({ telegramId: 'tg-1', botTemplateId: 'gastos' });
    expect(r.tenant).toBeNull();
    expect(r.needsInvitation).toBe(true);
    expect(r.user.telegramId).toBe('tg-1');
  });

  it('con startPayload válido: consume invitación y crea membership', async () => {
    const { resolver, businesses, invitationService } = setup();
    const biz = businesses.seed(makeBusiness({ id: 'biz-1', templateId: 'gastos' }));
    const created = await invitationService.create(biz.id, 'OWNER', { botUsername: 'b' });
    const r = await resolver.resolve({ telegramId: 'tg-2', botTemplateId: 'gastos', startPayload: created.token });
    expect(r.justJoined).toBe(true);
    expect(r.tenant?.business.id).toBe('biz-1');
    expect(r.tenant?.membership.role).toBe('OWNER');
  });

  it('una sola membership: resuelve ese negocio', async () => {
    const { resolver, businesses, users, membershipRepo } = setup();
    const biz = businesses.seed(makeBusiness({ id: 'biz-1', templateId: 'gastos' }));
    const user = await users.create('tg-3');
    await membershipRepo.create({ businessId: biz.id, userId: user.id, role: 'EMPLOYEE' });
    const r = await resolver.resolve({ telegramId: 'tg-3', botTemplateId: 'gastos' });
    expect(r.tenant?.business.id).toBe('biz-1');
  });

  it('ignora negocios de otro template (un bot = un template)', async () => {
    const { resolver, businesses, users, membershipRepo } = setup();
    const biz = businesses.seed(makeBusiness({ id: 'biz-1', templateId: 'kiosco' }));
    const user = await users.create('tg-4');
    await membershipRepo.create({ businessId: biz.id, userId: user.id, role: 'OWNER' });
    const r = await resolver.resolve({ telegramId: 'tg-4', botTemplateId: 'gastos' });
    expect(r.tenant).toBeNull();
    expect(r.needsInvitation).toBe(true);
  });

  it('varias memberships: elige la usada más recientemente', async () => {
    const { resolver, businesses, users, membershipRepo } = setup();
    const a = businesses.seed(makeBusiness({ id: 'biz-a', templateId: 'gastos' }));
    const b = businesses.seed(makeBusiness({ id: 'biz-b', templateId: 'gastos' }));
    const user = await users.create('tg-5');
    const ma = await membershipRepo.create({ businessId: a.id, userId: user.id, role: 'EMPLOYEE' });
    const mb = await membershipRepo.create({ businessId: b.id, userId: user.id, role: 'EMPLOYEE' });
    await membershipRepo.touchLastUsed(ma.id, new Date('2026-01-01T00:00:00Z'));
    await membershipRepo.touchLastUsed(mb.id, new Date('2026-06-01T00:00:00Z'));
    const r = await resolver.resolve({ telegramId: 'tg-5', botTemplateId: 'gastos' });
    expect(r.tenant?.business.id).toBe('biz-b');
    expect(r.memberships).toHaveLength(2);
  });
});
