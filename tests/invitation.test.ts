import { describe, expect, it } from 'vitest';
import { InvitationService } from '../src/core/identity/invitation.service.js';
import { AuditService } from '../src/core/audit/audit.service.js';
import { FakeAuditRepo, FakeInvitationRepo, makeBusiness } from './fakes.js';

function setup() {
  const invitations = new FakeInvitationRepo();
  const audit = new AuditService(new FakeAuditRepo());
  const service = new InvitationService(invitations, audit);
  const business = makeBusiness();
  return { service, invitations, business };
}

describe('InvitationService', () => {
  it('crea invitación con token aleatorio y deep link (el hash queda en DB, no el token)', async () => {
    const { service, business } = setup();
    const a = await service.create(business.id, 'OWNER', { botUsername: 'mi_bot' });
    const b = await service.create(business.id, 'OWNER', { botUsername: 'mi_bot' });
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(40);
    expect(a.deepLink).toBe(`https://t.me/mi_bot?start=${a.token}`);
    expect(a.invitation.tokenHash).not.toContain(a.token);
  });

  it('consume válida: marca un solo uso y asigna rol', async () => {
    const { service, business } = setup();
    const created = await service.create(business.id, 'EMPLOYEE', { botUsername: 'b' });
    const consumed = await service.consume(created.token, 'user-1');
    expect(consumed.businessId).toBe(business.id);
    expect(consumed.role).toBe('EMPLOYEE');
    expect(consumed.usedByUserId).toBe('user-1');
  });

  it('segundo uso del mismo token falla', async () => {
    const { service, business } = setup();
    const created = await service.create(business.id, 'EMPLOYEE', { botUsername: 'b' });
    await service.consume(created.token, 'user-1');
    await expect(service.consume(created.token, 'user-2')).rejects.toThrow(/ya fue utilizada/);
  });

  it('token expirado falla', async () => {
    const { service, business } = setup();
    const created = await service.create(business.id, 'EMPLOYEE', { botUsername: 'b', ttlHours: 0 });
    await expect(service.consume(created.token, 'user-1')).rejects.toThrow(/expiró/);
  });

  it('token revocado falla', async () => {
    const { service, invitations, business } = setup();
    const created = await service.create(business.id, 'EMPLOYEE', { botUsername: 'b' });
    await service.revoke(business.id, created.invitation.id, 'owner-1');
    expect((await invitations.findById(created.invitation.id))?.revokedAt).not.toBeNull();
    await expect(service.consume(created.token, 'user-1')).rejects.toThrow(/revocada/);
  });

  it('token desconocido falla', async () => {
    const { service } = setup();
    await expect(service.consume('token-inexistente', 'user-1')).rejects.toThrow(/inválida/);
  });
});
