/**
 * Alta manual de un negocio para desarrollo/pruebas (sin web admin todavía).
 * Uso:
 *   pnpm seed -- --name "Kiosco Don Pepe" --template gastos [--owner-telegram-id 123]
 * Crea el Business, corre los seeds del template y genera invitación de OWNER.
 */
import { Bot } from 'grammy';
import { loadConfig, configuredBots } from '../src/core/config/config.js';
import { logger } from '../src/core/logging/logger.js';
import { prisma } from '../src/infrastructure/persistence/prisma.js';
import {
  PrismaAuditRepository,
  PrismaBusinessRepository,
  PrismaInvitationRepository,
} from '../src/infrastructure/persistence/core.repositories.js';
import { AuditService } from '../src/core/audit/audit.service.js';
import { InvitationService } from '../src/core/identity/invitation.service.js';
import { createGastosTemplate } from '../src/templates/gastos/index.js';
import { MembershipService } from '../src/core/identity/membership.service.js';
import { PrismaMembershipRepository } from '../src/infrastructure/persistence/core.repositories.js';
import { UserService } from '../src/core/identity/user.service.js';
import { PrismaUserRepository } from '../src/infrastructure/persistence/core.repositories.js';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main() {
  if (!arg('name')) {
    console.log('Uso: pnpm seed -- --name "Nombre del negocio" --template gastos [--owner-telegram-id 123]');
    process.exit(1);
  }
  const templateId = arg('template') ?? 'gastos';
  if (templateId !== 'gastos') {
    console.error(`Template '${templateId}' no implementado todavía.`);
    process.exit(1);
  }

  const config = loadConfig();
  const businesses = new PrismaBusinessRepository(prisma);
  const business = await businesses.create({ name: arg('name') as string, templateId });

  // Seeds del template.
  const memberships = new MembershipService(new PrismaMembershipRepository(prisma));
  const gastos = createGastosTemplate({ db: prisma, memberships, apiSecret: config.API_SECRET });
  await gastos.seedBusiness(business.id);

  // Invitación de OWNER (o membership directa si se pasa el telegram id).
  const ownerTelegramId = arg('owner-telegram-id');
  if (ownerTelegramId) {
    const users = new UserService(new PrismaUserRepository(prisma));
    const user = await users.getOrCreateByTelegramId(ownerTelegramId);
    await memberships.ensureMembership(business.id, user.id, 'OWNER');
    console.log(`Negocio '${business.name}' creado (${business.id}). OWNER vinculado directo (telegram ${ownerTelegramId}).`);
  } else {
    const binding = configuredBots(config).find((b) => b.templateId === templateId);
    if (!binding) {
      console.error(`No hay bot configurado para '${templateId}'.`);
      process.exit(1);
    }
    const me = await new Bot(binding.token).api.getMe();
    const invitations = new InvitationService(
      new PrismaInvitationRepository(prisma),
      new AuditService(new PrismaAuditRepository(prisma))
    );
    const created = await invitations.create(business.id, 'OWNER', { ttlHours: 7 * 24, botUsername: me.username });
    console.log(`Negocio '${business.name}' creado (${business.id}).`);
    console.log(`Enlace de OWNER: ${created.deepLink}`);
  }
  await prisma.$disconnect();
}

main().catch((error) => {
  logger.error('Error en seed', error);
  process.exit(1);
});
