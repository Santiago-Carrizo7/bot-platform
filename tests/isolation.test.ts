/**
 * Aislamiento multi-tenant contra PostgreSQL real.
 * Requiere: TEST_DATABASE_URL="postgresql://postgres:postgrespassword@localhost:5432/bot_platform_test"
 * Crear la DB una vez: CREATE DATABASE bot_platform_test;
 * Sin esa variable, el archivo se saltea (los unitarios con fakes cubren la lógica).
 */
import { execSync } from 'node:child_process';
import { describe, expect, it, beforeAll } from 'vitest';

const TEST_DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB)('tenant isolation (postgres real)', () => {
  let repos: {
    businesses: import('../src/infrastructure/persistence/core.repositories.js').PrismaBusinessRepository;
    users: import('../src/infrastructure/persistence/core.repositories.js').PrismaUserRepository;
    memberships: import('../src/infrastructure/persistence/core.repositories.js').PrismaMembershipRepository;
    audit: import('../src/infrastructure/persistence/core.repositories.js').PrismaAuditRepository;
    conversations: import('../src/infrastructure/persistence/core.repositories.js').PrismaConversationRepository;
    prisma: import('@prisma/client').PrismaClient;
  };

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: TEST_DB },
      stdio: 'pipe',
    });
    const { PrismaClient } = await import('@prisma/client');
    const {
      PrismaBusinessRepository,
      PrismaUserRepository,
      PrismaMembershipRepository,
      PrismaAuditRepository,
      PrismaConversationRepository,
    } = await import('../src/infrastructure/persistence/core.repositories.js');
    const prisma = new PrismaClient({ datasources: { db: { url: TEST_DB } } });
    // Limpieza del run anterior.
    await prisma.auditLog.deleteMany();
    await prisma.conversationState.deleteMany();
    await prisma.membership.deleteMany();
    await prisma.invitation.deleteMany();
    await prisma.user.deleteMany();
    await prisma.business.deleteMany();
    repos = {
      prisma,
      businesses: new PrismaBusinessRepository(prisma),
      users: new PrismaUserRepository(prisma),
      memberships: new PrismaMembershipRepository(prisma),
      audit: new PrismaAuditRepository(prisma),
      conversations: new PrismaConversationRepository(prisma),
    };
  }, 120_000);

  it('los datos de un negocio nunca son visibles desde otro', async () => {
    const bizA = await repos.businesses.create({ name: 'Kiosco A', templateId: 'gastos' });
    const bizB = await repos.businesses.create({ name: 'Kiosco B', templateId: 'gastos' });
    const userA = await repos.users.create('tg-aaa');
    const userB = await repos.users.create('tg-bbb');
    await repos.memberships.create({ businessId: bizA.id, userId: userA.id, role: 'OWNER' });
    await repos.memberships.create({ businessId: bizB.id, userId: userB.id, role: 'OWNER' });

    // Memberships no cruzan negocios.
    expect(await repos.memberships.findByUserAndBusiness(userA.id, bizB.id)).toBeNull();
    expect(await repos.memberships.findByUserWithBusiness(userA.id)).toHaveLength(1);

    // Auditoría scropeada por negocio.
    await repos.audit.log({ businessId: bizA.id, actorUserId: userA.id, action: 'venta.creada' });
    await repos.audit.log({ businessId: bizB.id, actorUserId: userB.id, action: 'venta.creada' });
    const logsA = await repos.audit.listByBusiness(bizA.id);
    expect(logsA).toHaveLength(1);
    expect(logsA[0].actorUserId).toBe(userA.id);

    // Conversaciones separadas por (negocio, usuario).
    await repos.conversations.upsert({
      businessId: bizA.id,
      userId: userA.id,
      phase: 'COLLECTING',
      actionName: 'registrar_gasto',
      data: {},
      expiresAt: null,
      updatedAt: new Date(),
    });
    expect(await repos.conversations.get(bizB.id, userA.id)).toBeNull();

    // Constraints: mismo nombre de categoría no aplica aquí, pero el unique
    // (businessId, userId) impide doble membership.
    await expect(
      repos.memberships.create({ businessId: bizA.id, userId: userA.id, role: 'EMPLOYEE' })
    ).rejects.toThrow();

    await repos.prisma.$disconnect();
  });
});
