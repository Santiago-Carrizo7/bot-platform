/**
 * Alta manual de invitaciones (sin web admin todavía).
 * Uso:
 *   pnpm invite -- --business <BUSINESS_ID> --role OWNER|EMPLOYEE [--days 7] [--bot-username mi_bot]
 * Si no se pasa --bot-username, se obtiene con getMe() usando el token del template del negocio.
 */
import { Bot } from 'grammy';
import { loadConfig, configuredBots } from '../src/core/config/config.js';
import { logger } from '../src/core/logging/logger.js';
import { prisma } from '../src/infrastructure/persistence/prisma.js';
import { PrismaBusinessRepository } from '../src/infrastructure/persistence/core.repositories.js';
import { PrismaInvitationRepository } from '../src/infrastructure/persistence/core.repositories.js';
import { PrismaAuditRepository } from '../src/infrastructure/persistence/core.repositories.js';
import { AuditService } from '../src/core/audit/audit.service.js';
import { InvitationService } from '../src/core/identity/invitation.service.js';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main() {
  if (arg('help') !== undefined || !arg('business') || !arg('role')) {
    console.log('Uso: pnpm invite -- --business <ID> --role OWNER|EMPLOYEE [--days 7] [--bot-username mi_bot]');
    process.exit(arg('help') !== undefined ? 0 : 1);
  }
  const role = arg('role') as string;
  if (role !== 'OWNER' && role !== 'EMPLOYEE') {
    console.error('role debe ser OWNER o EMPLOYEE');
    process.exit(1);
  }

  const config = loadConfig();
  const businesses = new PrismaBusinessRepository(prisma);
  const business = await businesses.findById(arg('business') as string);
  if (!business) {
    console.error('Negocio no encontrado');
    process.exit(1);
  }

  let botUsername = arg('bot-username');
  if (!botUsername) {
    const binding = configuredBots(config).find((b) => b.templateId === business.templateId);
    if (!binding) {
      console.error(`No hay bot configurado para el template '${business.templateId}'. Pasá --bot-username.`);
      process.exit(1);
    }
    const me = await new Bot(binding.token).api.getMe();
    botUsername = me.username;
  }

  const invitations = new InvitationService(
    new PrismaInvitationRepository(prisma),
    new AuditService(new PrismaAuditRepository(prisma))
  );
  const created = await invitations.create(business.id, role, {
    ttlHours: Number(arg('days') ?? 7) * 24,
    botUsername,
  });
  console.log(`Negocio: ${business.name} (${business.id})`);
  console.log(`Rol: ${role} — expira: ${created.invitation.expiresAt.toISOString()}`);
  console.log(`Enlace: ${created.deepLink}`);
  await prisma.$disconnect();
}

main().catch((error) => {
  logger.error('Error al generar invitación', error);
  process.exit(1);
});
