import { Bot, webhookCallback } from 'grammy';
import type { RequestHandler } from 'express';
import { AppError } from '../../core/errors/errors.js';
import { logger } from '../../core/logging/logger.js';
import type { FlowDeps, BotReply } from '../../core/messaging/flow.js';
import { handleCallback, handleText } from '../../core/messaging/flow.js';
import { evaluateAccess } from '../../core/tenant/business-status.js';
import type { TenantResolver } from '../../core/tenant/resolver.js';
import { SpeechToTextService } from '../../core/stt/stt.service.js';
import type { VisionService } from '../ai/vision.service.js';
import type { BotContext } from './bot-context.js';
import { InMemoryRateLimiter } from './rate-limit.js';

export interface CreateBotDeps {
  token: string;
  templateId: string;
  flowDeps: FlowDeps;
  resolver: TenantResolver;
  sttService: SpeechToTextService;
  visionService?: VisionService;
}

const BASE_COMMANDS = [
  { command: 'start', description: 'Comenzar' },
  { command: 'menu', description: 'Ver el menú' },
  { command: 'ayuda', description: 'Ayuda' },
  { command: 'negocios', description: 'Cambiar de negocio' },
  { command: 'cancelar', description: 'Cancelar lo que estoy haciendo' },
];

export function createBot(deps: CreateBotDeps): Bot<BotContext> {
  const { token, templateId, flowDeps, resolver, sttService, visionService } = deps;
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

  // Fotos de libretas/cuadernos de ventas y gastos.
  bot.on('message:photo', async (ctx) => {
    let statusMsgId: number | undefined;
    try {
      const resolution = requireResolution(ctx);
      if (!resolution.tenant) {
        await ctx.reply('Necesitás una invitación para usar este bot.');
        return;
      }

      if (!visionService || !visionService.isConfigured()) {
        await ctx.reply('El análisis de fotos no está configurado en el servidor.');
        return;
      }

      const tenant = resolution.tenant;
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      const count = await flowDeps.aiUsage.countVisionByBusinessSince(tenant.business.id, startOfDay);
      if (count >= 5) {
        await ctx.reply(
          '⚠️ *Límite diario de fotos alcanzado*\n\n' +
            'Por hoy ya alcanzaste el límite de *5 fotos* procesadas para tu negocio.\n' +
            'Podés seguir registrando ventas y gastos por *texto* o *mensaje de voz*.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Feedback inicial inmediato
      const statusMsg = await ctx.reply('📸 Analizando foto de la libreta...');
      statusMsgId = statusMsg.message_id;

      // Descargar foto con mejor resolución
      const { buffer, mimeType } = await downloadPhoto(ctx, token);

      // Extraer datos con VisionService
      const result = await visionService.extractLedgerItems(buffer.toString('base64'), mimeType);

      // Registrar uso en aiUsage para conteo y auditoría
      await flowDeps.aiUsage.log({
        businessId: tenant.business.id,
        userId: resolution.user.id,
        provider: 'vision',
        model: `vision:${result.model}`,
      });

      if (result.items.length === 0) {
        const noItemsMsg =
          '🔍 No pude identificar montos de ventas ni gastos en la foto.\n\n' +
          'Asegurate de que los números sean legibles, con buena luz y sacá la foto bien de cerca.';
        await ctx.api
          .editMessageText(ctx.chat.id, statusMsgId, noItemsMsg)
          .catch(async () => {
            await ctx.reply(noItemsMsg).catch(() => undefined);
          });
        return;
      }

      const action = flowDeps.template.actions.find((a) => a.name === 'registrar_lote');
      if (!action) {
        const notSupportedMsg = 'Este bot no tiene soporte para registro de movimientos por fotos.';
        await ctx.api
          .editMessageText(ctx.chat.id, statusMsgId, notSupportedMsg)
          .catch(async () => {
            await ctx.reply(notSupportedMsg).catch(() => undefined);
          });
        return;
      }

      const now = new Date();
      const access = evaluateAccess(tenant.business, now);
      if (!access.canWrite) {
        const readOnlyMsg =
          'Este negocio está en modo solo lectura (el período de prueba terminó). Podés consultar, pero no registrar cambios.';
        await ctx.api
          .editMessageText(ctx.chat.id, statusMsgId, readOnlyMsg)
          .catch(async () => {
            await ctx.reply(readOnlyMsg).catch(() => undefined);
          });
        return;
      }

      await flowDeps.conversations.upsert({
        businessId: tenant.business.id,
        userId: resolution.user.id,
        phase: 'CONFIRMING',
        actionName: 'registrar_lote',
        data: { items: result.items },
        expiresAt: new Date(now.getTime() + (flowDeps.conversationTtlMs ?? 10 * 60_000)),
        updatedAt: now,
      });

      const summary = action.summarize ? action.summarize({ items: result.items }) : 'Revisá los datos.';
      const confirmText = `${summary}\n\n¿Confirmás el registro de estos movimientos en la caja?`;

      await ctx.api
        .editMessageText(ctx.chat.id, statusMsgId, confirmText, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Confirmar todos', callback_data: 'confirm:yes' },
                { text: '❌ Cancelar', callback_data: 'confirm:no' },
              ],
            ],
          },
        })
        .catch(async () => {
          await ctx.reply(confirmText, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Confirmar todos', callback_data: 'confirm:yes' },
                  { text: '❌ Cancelar', callback_data: 'confirm:no' },
                ],
              ],
            },
          });
        });
    } catch (error) {
      const message =
        error instanceof AppError
          ? error.message
          : 'Ocurrió un error inesperado al analizar la imagen. Probá de nuevo en un momento.';

      if (error instanceof AppError) {
        logger.warn('Error de aplicación en foto', { code: error.code, message: error.message });
      } else {
        logger.error('Error no controlado al procesar foto', error);
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

async function downloadPhoto(
  ctx: BotContext,
  token: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) throw new AppError('No se encontró la foto.');
  const largestPhoto = photos[photos.length - 1];
  const file = await ctx.api.getFile(largestPhoto.file_id);
  if (!file.file_path) throw new AppError('No se pudo descargar la imagen desde Telegram.');
  const downloadUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(downloadUrl);
  if (!response.ok) throw new AppError('No se pudo descargar la imagen desde Telegram.');
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, mimeType: 'image/jpeg' };
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
