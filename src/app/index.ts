import type { Server } from 'node:http';
import { loadConfig } from '../core/config/config.js';
import { logger } from '../core/logging/logger.js';
import { prisma } from '../infrastructure/persistence/prisma.js';
import { buildBots, buildCoreServices, buildHttpApp, verifyBotTokens } from './container.js';
import { createGastosTemplate } from '../templates/gastos/index.js';
import { createKioscoTemplate } from '../templates/kiosco/index.js';

async function bootstrap() {
  const config = loadConfig();
  logger.info('Iniciando bot-platform...');

  const core = buildCoreServices(config);

  // Templates registrados por import estático (sin plugins).
  const gastos = createGastosTemplate({
    db: prisma,
    memberships: core.memberships,
    apiSecret: config.API_SECRET,
  });
  const kiosco = createKioscoTemplate({ db: prisma });
  const templates = [gastos.template, kiosco.template];

  const bots = buildBots(config, core, templates);
  const app = buildHttpApp(core, [gastos.router]);

  let httpServer: Server | undefined;
  await new Promise<void>((resolve) => {
    httpServer = app.listen(config.PORT, () => {
      logger.info(`Servidor HTTP en http://localhost:${config.PORT} (/health)`);
      resolve();
    });
  });

  const shutdown = async (signal: string) => {
    logger.info(`Señal ${signal}. Apagado...`);
    try {
      if (httpServer) await new Promise<void>((res) => httpServer?.close(() => res()));
      await Promise.all(bots.map((b) => b.bot.stop()));
      await prisma.$disconnect();
      logger.info('Apagado completo.');
      process.exit(0);
    } catch (error) {
      logger.error('Error durante el apagado', error);
      process.exit(1);
    }
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  logger.info('Validando tokens de Telegram...');
  await verifyBotTokens(bots);

  logger.info('Iniciando long polling...');
  await Promise.all(
    bots.map(async ({ templateId, bot }) => {
      await bot.start({
        onStart: (info) => logger.info(`Bot '${templateId}' como @${info.username}`),
      });
    })
  );
}

bootstrap().catch((error) => {
  // Serializar el mensaje: los errores de red/API llegan como {} si se loguean crudos.
  const detail =
    error instanceof Error ? { message: error.message, stack: error.stack } : { error: String(error) };
  logger.error('Error fatal al iniciar', detail);
  process.exit(1);
});
