import { Bot, webhookCallback } from 'grammy';
import type { RequestHandler } from 'express';
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
  { command: 'start', description: 'Comenzar' },
  { command: 'menu', description: 'Ver el menú' },
  { command: 'ayuda', description: 'Ayuda' },
  { command: 'negocios', description: 'Cambiar de negocio' },
  { command: 'cancelar', description: 'Cancelar lo que estoy haciendo' },
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
  bot.command(['start', 'menu', 'ayuda', 'cancelar', 'negocios', 'invitar', ...templateCommands], async (ctx) => {
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

  // Audio → STT con feedback progresivo en un único mensaje editable.
  bot.on(['message:voice', 'message:audio'], async (ctx) => {
    let statusMsgId: number | undefined;
    try {
      const resolution = requireResolution(ctx);
      if (!sttService.isConfigured()) {
        await ctx.reply('El procesamiento de audio no está configurado en el servidor.');
        return;
      }

      // 1. Feedback visual inmediato
      const statusMsg = await ctx.reply('🎙️ Escuchando audio...');
      statusMsgId = statusMsg.message_id;

      // 2. Transcripción con STT (Groq Whisper)
      const transcript = await transcribeUpdate(ctx, token, sttService);
      logger.info('Audio transcripto', { businessId: resolution.tenant?.business.id, transcript });

      // 3. Feedback intermedio: muestra lo que entendió el STT + calculando
      await ctx.api
        .editMessageText(
          ctx.chat.id,
          statusMsgId,
          formatAudioStatus(transcript),
          { parse_mode: 'Markdown' }
        )
        .catch(() => undefined);

      // 4. Procesamiento en el pipeline
      const reply = await handleText(flowDeps, {
        resolution,
        text: transcript,
        firstName: ctx.from?.first_name,
        now: new Date(),
      });

      // 5. Respuesta final editando el mismo mensaje
      const finalInline = reply.inlineKeyboard
        ? {
            inline_keyboard: reply.inlineKeyboard.map((row) =>
              row.map((b) => ({ text: b.text, callback_data: b.callbackData }))
            ),
          }
        : undefined;

      const finalText = formatAudioFinal(transcript, reply.text, reply.parseMode);

      await ctx.api
        .editMessageText(ctx.chat.id, statusMsgId, finalText, {
          parse_mode: reply.parseMode ?? 'Markdown',
          reply_markup: finalInline,
        })
        .catch(async (editErr) => {
          logger.warn('No se pudo editar mensaje de audio, enviando uno nuevo', editErr);
          await ctx.reply(finalText, {
            parse_mode: reply.parseMode ?? 'Markdown',
            reply_markup: finalInline,
          });
        });
    } catch (error) {
      const message =
        error instanceof AppError
          ? error.message
          : 'Ocurrió un error inesperado al procesar el audio. Probá de nuevo en un momento.';

      if (error instanceof AppError) {
        logger.warn('Error de aplicación en audio', { code: error.code, message: error.message });
      } else {
        logger.error('Error no controlado al procesar audio', error);
      }

      if (statusMsgId) {
        await ctx.api
          .editMessageText(ctx.chat.id, statusMsgId, `❌ ${message}`)
          .catch(async () => {
            await ctx.reply(message).catch(() => undefined);
          });
      } else {
        await ctx.reply(message).catch(() => undefined);
      }
    }
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

  // Lo del negocio primero (lenguaje del usuario), lo técnico después.
  void bot.api
    .setMyCommands([...(flowDeps.template.menuCommands ?? []), ...BASE_COMMANDS])
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

/**
 * Rutas de webhook (una por bot) para montar en Express.
 * Telegram empuja cada update con POST; el header secreto lo valida grammY.
 */
export interface TelegramWebhookRoute {
  method: 'post';
  path: string;
  handler: RequestHandler;
}

export function buildTelegramWebhookRoutes(
  bots: Array<{ templateId: string; bot: Bot<BotContext> }>,
  secretToken: string
): TelegramWebhookRoute[] {
  return bots.map(({ templateId, bot }) => ({
    method: 'post' as const,
    path: `/telegram/${templateId}`,
    handler: webhookCallback(bot, 'express', {
      secretToken,
      timeoutMilliseconds: 30_000,
      onTimeout: 'return',
    }) as unknown as RequestHandler,
  }));
}

function escapeMarkdownV1(text: string): string {
  return text.replace(/([_*`\[])/g, '\\$1');
}

function formatAudioStatus(transcript: string): string {
  return `🎙️ _«${escapeMarkdownV1(transcript)}»_\n⏳ Calculando...`;
}

function formatAudioFinal(transcript: string, body: string, parseMode?: 'Markdown' | 'HTML'): string {
  if (parseMode === 'HTML') {
    const escaped = transcript.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `🎙️ <i>«${escaped}»</i>\n\n${body}`;
  }
  if (parseMode === 'Markdown') {
    return `🎙️ _«${escapeMarkdownV1(transcript)}»_\n\n${body}`;
  }
  return `🎙️ «${transcript}»\n\n${body}`;
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
