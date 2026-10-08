import type { Express, Router } from 'express';
import { Bot } from 'grammy';
import { configuredBots, type AppConfig } from '../core/config/config.js';
import { AppError } from '../core/errors/errors.js';
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
import { OpenAICompatibleChatProvider } from '../infrastructure/ai/openai-compatible-chat.provider.js';
import { FallbackAIProvider } from '../infrastructure/ai/fallback.provider.js';
import { VisionService } from '../infrastructure/ai/vision.service.js';
import { OpenAICompatibleSTTProvider } from '../infrastructure/stt/openai-compatible-stt.provider.js';
import { createBot, type CreateBotDeps } from '../infrastructure/telegram/bot.js';
import type { BotContext } from '../infrastructure/telegram/bot-context.js';
import type { IAIProvider } from '../core/ai/types.js';
import { createExpressApp, type ExtraRoute, type TemplateRouter } from '../infrastructure/http/server.js';
import { botNotConfigured, createAdminRouter, type AdminTemplateOption } from './admin/router.js';

export interface BuiltAIProvider {
  provider: IAIProvider;
  modelDescription: string;
}

/**
 * Resuelve y compone los proveedores de IA según las credenciales disponibles.
 * Orden de la cascada gratuita (failover transparente):
 * 1. Groq (Llama 3.3 70B: ultra rápido <300ms, tier libre: 30 RPM, 14.400 RPD).
 * 2. OpenRouter (con modelos gratuitos seleccionados que soportan JSON).
 * 3. Google Gemini directo (AI Studio: 15 RPM, 1.500 RPD).
 */
export function buildAIProvider(config: AppConfig): BuiltAIProvider {
  const providers: IAIProvider[] = [];

  // 1. Groq (reutiliza STT_API_KEY si STT_PROVIDER=groq, o GROQ_API_KEY específica)
  const groqKey = config.GROQ_API_KEY || (config.STT_PROVIDER === 'groq' ? config.STT_API_KEY : undefined);
  if (groqKey && (config.AI_PROVIDER === 'fallback' || config.AI_PROVIDER === 'groq')) {
    providers.push(
      new OpenAICompatibleChatProvider({
        name: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: groqKey,
        model: config.GROQ_MODEL,
        responseFormatJson: true,
      })
    );
  }

  // 2. OpenRouter (con fallback nativo en lista de modelos gratuitos seleccionados)
  if (config.OPENROUTER_API_KEY && (config.AI_PROVIDER === 'fallback' || config.AI_PROVIDER === 'openrouter')) {
    providers.push(
      new OpenRouterProvider({
        apiKey: config.OPENROUTER_API_KEY,
        model: config.OPENROUTER_MODEL,
        siteName: 'bot-platform',
      })
    );
  }

  // 3. Google Gemini directo (AI Studio)
  if (config.GEMINI_API_KEY && (config.AI_PROVIDER === 'fallback' || config.AI_PROVIDER === 'gemini')) {
    providers.push(
      new OpenAICompatibleChatProvider({
        name: 'Google Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKey: config.GEMINI_API_KEY,
        model: config.GEMINI_MODEL,
        responseFormatJson: true,
      })
    );
  }

  if (providers.length === 0) {
    const fallback = new OpenRouterProvider({
      apiKey: config.OPENROUTER_API_KEY ?? 'dummy',
      model: config.OPENROUTER_MODEL,
    });
    return { provider: fallback, modelDescription: config.OPENROUTER_MODEL };
  }

  if (providers.length === 1) {
    return {
      provider: providers[0],
      modelDescription: (providers[0] as { model?: string }).model ?? config.OPENROUTER_MODEL,
    };
  }

  const fallbackProvider = new FallbackAIProvider(providers);
  return {
    provider: fallbackProvider,
    modelDescription: providers.map((p) => p.name).join(' -> '),
  };
}

export interface CoreServices {
  users: UserService;
  businesses: BusinessService;
  memberships: MembershipService;
  invitations: InvitationService;
  resolver: TenantResolver;
  interpreter: ActionInterpreter;
  stt: SpeechToTextService;
  vision: VisionService;
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

  const { provider: aiProvider, modelDescription } = buildAIProvider(config);
  const interpreter = new ActionInterpreter(aiProvider);

  const groqKey = config.GROQ_API_KEY || (config.STT_PROVIDER === 'groq' ? config.STT_API_KEY : undefined);
  const vision = new VisionService({
    geminiKey: config.GEMINI_API_KEY,
    openRouterKey: config.OPENROUTER_API_KEY,
    groqKey,
  });

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
    aiModel: modelDescription,
  };

  return { users, businesses, memberships, invitations, resolver, interpreter, stt, vision, audit, flowBase, apiSecret: config.API_SECRET };
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
      visionService: core.vision,
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

/**
 * Username del bot de una vertical, resuelto una vez y cacheado. Copia del
 * patrón de `scripts/invite.ts`; funciona aunque `TELEGRAM_POLLING=off`.
 */
export function createBotUsernameResolver(config: AppConfig): (templateId: string) => Promise<string> {
  const cache = new Map<string, string>();
  return async (templateId: string): Promise<string> => {
    const cached = cache.get(templateId);
    if (cached) return cached;
    let token: string | undefined;
    try {
      token = configuredBots(config).find((b) => b.templateId === templateId)?.token;
    } catch {
      token = undefined;
    }
    if (!token) throw botNotConfigured(templateId);
    const me = await new Bot(token).api.getMe();
    cache.set(templateId, me.username);
    return me.username;
  };
}

/** Callbacks que el composition root aporta al admin (los únicos que toca). */
export interface AdminComposition {
  templates: AdminTemplateOption[];
  seedBusiness: (templateId: string, businessId: string) => Promise<void>;
  resolveBotUsername: (templateId: string) => Promise<string>;
}

/** Router del admin web. `undefined` si no hay `ADMIN_PASSWORD` (→ /admin 404). */
export function buildAdminRouter(core: CoreServices, config: AppConfig, composition: AdminComposition): Router | undefined {
  if (!config.ADMIN_PASSWORD) {
    logger.info('Admin web desactivado (sin ADMIN_PASSWORD).');
    return undefined;
  }
  logger.info('Admin web activo en /admin');
  return createAdminRouter({
    password: config.ADMIN_PASSWORD,
    apiSecret: config.API_SECRET,
    businesses: core.businesses,
    memberships: core.memberships,
    users: core.users,
    invitations: core.invitations,
    audit: core.audit,
    templates: composition.templates,
    seedBusiness: composition.seedBusiness,
    resolveBotUsername: composition.resolveBotUsername,
  });
}

export function buildHttpApp(
  core: CoreServices,
  templateRouters: TemplateRouter[] = [],
  extraRoutes: ExtraRoute[] = [],
  adminRouter?: Router
): Express {
  return createExpressApp({
    memberships: core.memberships,
    users: core.users,
    apiSecret: core.apiSecret,
    templateRouters,
    extraRoutes,
    adminRouter,
  });
}
