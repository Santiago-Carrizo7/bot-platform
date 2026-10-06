import type { Express } from 'express';
import type { Bot } from 'grammy';
import { configuredBots, type AppConfig } from '../core/config/config.js';
import { logger } from '../core/logging/logger.js';
import type { TemplateDefinition } from '../core/actions/registry.js';
import { ActionInterpreter } from '../core/ai/interpreter.js';
import { AuditService } from '../core/audit/audit.service.js';
import { BusinessService } from '../core/tenant/business.service.js';
import { UserService } from '../core/identity/user.service.js';
import { MembershipService } from '../core/identity/membership.service.js';
import { InvitationService } from '../core/identity/invitation.service.js';
import { TenantResolver } from '../core/tenant/resolver.js';
import { SpeechToTextService } from '../core/stt/stt.service.js';
import type { FlowDeps } from '../core/messaging/flow.js';
import { prisma } from '../infrastructure/persistence/prisma.js';
import {
  PrismaAiUsageRepository,
  PrismaAuditRepository,
  PrismaBusinessRepository,
  PrismaConversationRepository,
  PrismaInvitationRepository,
  PrismaMembershipRepository,
  PrismaUserRepository,
} from '../infrastructure/persistence/core.repositories.js';
import { OpenRouterProvider } from '../infrastructure/ai/openrouter.provider.js';
import { OpenAICompatibleSTTProvider } from '../infrastructure/stt/openai-compatible-stt.provider.js';
import { createBot, type CreateBotDeps } from '../infrastructure/telegram/bot.js';
import type { BotContext } from '../infrastructure/telegram/bot-context.js';
import { createExpressApp, type TemplateRouter } from '../infrastructure/http/server.js';

export interface CoreServices {
  users: UserService;
  businesses: BusinessService;
  memberships: MembershipService;
  invitations: InvitationService;
  resolver: TenantResolver;
  interpreter: ActionInterpreter;
  stt: SpeechToTextService;
  audit: AuditService;
  flowBase: Omit<FlowDeps, 'template'>;
  apiSecret: string;
}

/** Servicios de Core cableados (sin bots, sin HTTP). Reutilizable en scripts. */
export function buildCoreServices(config: AppConfig): CoreServices {
  const userRepo = new PrismaUserRepository(prisma);
  const businessRepo = new PrismaBusinessRepository(prisma);
  const membershipRepo = new PrismaMembershipRepository(prisma);
  const invitationRepo = new PrismaInvitationRepository(prisma);
  const conversationRepo = new PrismaConversationRepository(prisma);
  const auditRepo = new PrismaAuditRepository(prisma);
  const aiUsageRepo = new PrismaAiUsageRepository(prisma);

  const audit = new AuditService(auditRepo);
  const users = new UserService(userRepo);
  const businesses = new BusinessService(businessRepo);
  const memberships = new MembershipService(membershipRepo);
  const invitations = new InvitationService(invitationRepo, audit);
  const resolver = new TenantResolver(users, memberships, membershipRepo, invitations);

  const aiProvider = new OpenRouterProvider({
    apiKey: config.OPENROUTER_API_KEY,
    model: config.OPENROUTER_MODEL,
    siteName: 'bot-platform',
  });
  const interpreter = new ActionInterpreter(aiProvider);

  const stt =
    config.STT_PROVIDER !== 'disabled' && config.STT_API_KEY
      ? new SpeechToTextService(
          new OpenAICompatibleSTTProvider({
            apiKey: config.STT_API_KEY,
            baseUrl: config.STT_BASE_URL,
            model: config.STT_MODEL,
            providerName: config.STT_PROVIDER === 'groq' ? 'Groq Whisper' : 'OpenAI Whisper',
          })
        )
      : new SpeechToTextService(undefined);

  const flowBase = {
    interpreter,
    conversations: conversationRepo,
    businesses: businessRepo,
    membershipRepo,
    audit,
    invitations,
    aiUsage: aiUsageRepo,
    aiProviderName: aiProvider.name,
    aiModel: config.OPENROUTER_MODEL,
  };

  return { users, businesses, memberships, invitations, resolver, interpreter, stt, audit, flowBase, apiSecret: config.API_SECRET };
}

export interface RunningBot {
  templateId: string;
  bot: Bot<BotContext>;
}

/**
 * Crea un bot de Telegram por vertical configurado (registro estático).
 * Valida cada token con getMe() ANTES de arrancar el polling: un token
 * inválido se detecta acá con un mensaje claro, en vez de morir con un 404
 * críptico en deleteWebhook. Además captura el username para los deep links
 * de invitación del comando /invitar.
 */
export async function buildBots(
  config: AppConfig,
  core: CoreServices,
  templates: TemplateDefinition[]
): Promise<RunningBot[]> {
  const byId = new Map(templates.map((t) => [t.id, t]));
  const running: RunningBot[] = [];
  for (const binding of configuredBots(config)) {
    const template = byId.get(binding.templateId);
    if (!template) {
      throw new Error(`Hay token configurado para el template '${binding.templateId}' pero no está registrado en el composition root.`);
    }
    const flowDeps = { ...core.flowBase, template };
    const botDeps: CreateBotDeps = {
      token: binding.token,
      templateId: binding.templateId,
      flowDeps,
      resolver: core.resolver,
      sttService: core.stt,
    };
    const bot = createBot(botDeps);
    try {
      const me = await bot.api.getMe();
      logger.info(`Token válido para '${binding.templateId}': @${me.username}`);
      flowDeps.inviteBotUsername = me.username;
    } catch {
      throw new Error(
        `Token de Telegram inválido para el template '${binding.templateId}'. ` +
          `Revisá la variable TELEGRAM_BOT_TOKEN_${binding.templateId.toUpperCase()} en el servidor.`
      );
    }
    running.push({ templateId: binding.templateId, bot });
    logger.info(`Bot registrado para el template '${binding.templateId}'`);
  }
  return running;
}

export function buildHttpApp(core: CoreServices, templateRouters: TemplateRouter[] = []): Express {
  return createExpressApp({
    memberships: core.memberships,
    users: core.users,
    apiSecret: core.apiSecret,
    templateRouters,
  });
}
