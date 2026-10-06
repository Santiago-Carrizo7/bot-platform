import { Bot } from 'grammy';
import { AppError } from '../../core/errors/errors.js';
import { logger } from '../../core/logging/logger.js';
import type { FlowDeps, BotReply } from '../../core/messaging/flow.js';
import { handleCallback, handleText } from '../../core/messaging/flow.js';
import type { TenantResolver } from '../../core/tenant/resolver.js';
import { SpeechToTextService } from '../../core/stt/stt.service.js';
import type { BotContext } from './bot-context.js';
import { InMemoryRateLimiter } from './rate-limit.js';

export interface CreateBotDeps {
  token: string;
  templateId: string;
  flowDeps: FlowDeps;
  resolver: TenantResolver;
  sttService: SpeechToTextService;
}

const BASE_COMMANDS = [
  { command: 'start', description: 'Comenzar / vincular invitación' },
  { command: 'menu', description: 'Ver el menú del negocio' },
  { command: 'ayuda', description: 'Ayuda y comandos' },
  { command: 'negocios', description: 'Cambiar de negocio' },
  { command: 'cancelar', description: 'Cancelar la conversación actual' },
];

export function createBot(deps: CreateBotDeps): Bot<BotContext> {
  const { token, templateId, flowDeps, resolver, sttService } = deps;
  const bot = new Bot<BotContext>(token);
  const limiter = new InMemoryRateLimiter();
  // Barra persistente de atajos del template (2 botones por fila).
  const quickRows = toRows((flowDeps.template.replyMenu ?? []).map((m) => m.label), 2);

  // Identidad + tenant en cada update, antes que cualquier handler.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Hablame por privado para operar con tu negocio.');
      return;
    }
    if (!ctx.from) return next();

    const telegramId = String(ctx.from.id);
    if (!limiter.allow(telegramId)) {
      await ctx.reply('Estás enviando demasiados mensajes. Esperá un momento.');
      return;
    }

    const startPayload = extractStartPayload(ctx);
    try {
      ctx.resolution = await resolver.resolve({ telegramId, botTemplateId: templateId, startPayload });
    } catch (error) {
      // Invitación inválida/expirada/usada: se informa y se frena el update.
      const message = error instanceof AppError ? error.message : 'No se pudo identificar tu acceso. Probá con /start.';
      logger.warn('Fallo al resolver tenant', { telegramId, error: message });
      await ctx.reply(message);
      return;
    }
    await next();
  });

  // Comandos base + comandos del template → todos pasan por el pipeline.
  const templateCommands = flowDeps.template.commands.map((c) => c.command);
  bot.command(['start', 'menu', 'ayuda', 'cancelar', 'negocios', ...templateCommands], async (ctx) => {
    await replySafely(
      ctx,
      () =>
        handleText(flowDeps, {
          resolution: requireResolution(ctx),
          text: ctx.message?.text ?? '',
          firstName: ctx.from?.first_name,
          now: new Date(),
        }),
      quickRows
    );
  });

  // Texto libre (freestyle) → pipeline.
  bot.on('message:text', async (ctx) => {
    await replySafely(
      ctx,
      () =>
        handleText(flowDeps, {
          resolution: requireResolution(ctx),
          text: ctx.message.text,
          firstName: ctx.from?.first_name,
          now: new Date(),
        }),
      quickRows
    );
  });

  // Audio → STT → mismo pipeline que el texto.
  bot.on(['message:voice', 'message:audio'], async (ctx) => {
    await replySafely(ctx, async () => {
      const resolution = requireResolution(ctx);
      if (!sttService.isConfigured()) {
        return { text: 'El procesamiento de audio no está configurado en el servidor.' };
      }
      await ctx.replyWithChatAction('typing');
      const transcript = await transcribeUpdate(ctx, token, sttService);
      logger.info('Audio transcripto', { businessId: resolution.tenant?.business.id, transcript });
      return handleText(flowDeps, {
        resolution,
        text: transcript,
        firstName: ctx.from?.first_name,
        now: new Date(),
      });
    }, quickRows);
  });

  // Botones inline (confirmar/cancelar/menú/negocios).
  bot.on('callback_query:data', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
    await replySafely(
      ctx,
      async () => {
        const resolution = requireResolution(ctx);
        if (!resolution.tenant) {
          return { text: 'Necesitás una invitación para usar este bot.' };
        }
        return handleCallback(flowDeps, {
          resolution,
          data: ctx.callbackQuery.data,
          now: new Date(),
        });
      },
      quickRows
    );
  });

  bot.catch((err) => {
    logger.error('Error no capturado en Grammy', { updateId: err.ctx.update.update_id, error: err.error });
  });

  void bot.api
    .setMyCommands([...BASE_COMMANDS, ...(flowDeps.template.menuCommands ?? [])])
    .catch((err) => logger.warn('No se pudo actualizar el menú de comandos en Telegram', err));

  return bot;
}

function requireResolution(ctx: BotContext) {
  if (!ctx.resolution) throw new AppError('No se pudo identificar tu usuario.', 'NO_RESOLUTION', 401);
  return ctx.resolution;
}

/** Extrae el token de `/start <TOKEN>` (deep link de invitación). */
function extractStartPayload(ctx: BotContext): string | undefined {
  const text = ctx.message?.text;
  if (!text) return undefined;
  const match = text.match(/^\/start\s+(\S+)/);
  return match ? match[1] : undefined;
}

async function transcribeUpdate(
  ctx: BotContext,
  token: string,
  sttService: SpeechToTextService
): Promise<string> {
  const voiceOrAudio = ctx.message?.voice ?? ctx.message?.audio;
  if (!voiceOrAudio) throw new AppError('No se pudo procesar el archivo de audio.');
  const file = await ctx.getFile();
  if (!file.file_path) throw new AppError('No se pudo descargar el audio desde Telegram.');
  const downloadUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(downloadUrl);
  if (!response.ok) throw new AppError('No se pudo descargar el audio desde Telegram.');
  const audioBuffer = Buffer.from(await response.arrayBuffer());
  return sttService.transcribe(audioBuffer, voiceOrAudio.mime_type ?? 'audio/ogg');
}

/** Parte las etiquetas en filas de N botones para el reply keyboard. */
function toRows(labels: string[], perRow: number): string[][] {
  const rows: string[][] = [];
  for (let i = 0; i < labels.length; i += perRow) {
    rows.push(labels.slice(i, i + perRow));
  }
  return rows;
}

async function replySafely(
  ctx: BotContext,
  run: () => Promise<BotReply>,
  keyboardRows: string[][] = []
): Promise<void> {
  try {
    await ctx.replyWithChatAction('typing').catch(() => undefined);
    const reply = await run();
    // Un mensaje lleva un solo reply_markup: el inline (confirmar/menú) gana;
    // si no hay, se muestra la barra persistente (ya visible desde antes igual).
    const reply_markup = reply.inlineKeyboard
      ? {
          inline_keyboard: reply.inlineKeyboard.map((row) =>
            row.map((b) => ({ text: b.text, callback_data: b.callbackData }))
          ),
        }
      : keyboardRows.length > 0
        ? { keyboard: keyboardRows.map((row) => row.map((text) => ({ text }))), resize_keyboard: true }
        : undefined;
    await ctx.reply(reply.text, { parse_mode: reply.parseMode, reply_markup });
  } catch (error) {
    // Los AppError son mensajes para el usuario; el resto es inesperado.
    if (error instanceof AppError) {
      logger.warn('Error de aplicación en bot', { code: error.code, message: error.message });
      await ctx.reply(error.message).catch(() => undefined);
      return;
    }
    logger.error('Error no controlado al procesar update', error);
    await ctx.reply('Ocurrió un error inesperado. Probá de nuevo en un momento.').catch(() => undefined);
  }
}
