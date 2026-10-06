import 'dotenv/config';
import { z } from 'zod';
import { ConfigError } from '../errors/errors.js';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  API_SECRET: z.string().min(16, 'API_SECRET es obligatorio (mínimo 16 caracteres)'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatorio'),

  // Un bot por vertical (registro estático). Agregar una línea por template nuevo.
  // Todos opcionales: arranca solo lo configurado (un string vacío también falla).
  TELEGRAM_BOT_TOKEN_GASTOS: z.string().min(1).optional(),
  TELEGRAM_BOT_TOKEN_KIOSCO: z.string().min(1).optional(),
  // Modo local sin Telegram (solo HTTP/API): TELEGRAM_POLLING=off.
  TELEGRAM_POLLING: z.enum(['on', 'off']).default('on'),
  // Webhook: si se define la URL pública, Telegram empuja los updates al
  // servidor (una ruta por bot) en vez de long polling.
  TELEGRAM_WEBHOOK_URL: z.string().url('TELEGRAM_WEBHOOK_URL debe ser una URL pública https').optional(),
  // Telegram solo acepta [A-Za-z0-9_-] (1-256 chars): base64 común (+/=) lo rechaza.
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .min(16)
    .max(256)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      'TELEGRAM_WEBHOOK_SECRET solo admite letras, números, _ y - (generar con: openssl rand -hex 24)'
    )
    .optional(),

  // Proveedor de IA de texto
  AI_PROVIDER: z.enum(['openrouter']).default('openrouter'),
  OPENROUTER_API_KEY: z.string().min(1, 'OPENROUTER_API_KEY es obligatorio'),
  OPENROUTER_MODEL: z.string().default('google/gemini-2.0-flash-001'),

  // Proveedor de Speech-to-Text
  STT_PROVIDER: z.enum(['groq', 'openai', 'disabled']).default('groq'),
  STT_API_KEY: z.string().optional(),
  STT_BASE_URL: z.string().optional(),
  STT_MODEL: z.string().default('whisper-large-v3-turbo'),

  // Negocio: trial y período de gracia (días)
  TRIAL_DAYS: z.coerce.number().int().positive().default(10),
  GRACE_DAYS: z.coerce.number().int().min(0).default(7),
}).superRefine((val, ctx) => {
  if (val.TELEGRAM_WEBHOOK_URL && !val.TELEGRAM_WEBHOOK_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TELEGRAM_WEBHOOK_SECRET'],
      message: 'TELEGRAM_WEBHOOK_SECRET es obligatorio cuando se define TELEGRAM_WEBHOOK_URL (mínimo 16 caracteres)',
    });
  }
});

export type AppConfig = z.infer<typeof configSchema>;

export interface BotBinding {
  templateId: string;
  token: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Error en variables de entorno:\n${issues}`);
  }
  return result.data;
}

/** Bots configurados (un bot por vertical). El orden define el orden de arranque. */
export function configuredBots(config: AppConfig): BotBinding[] {
  const bots: BotBinding[] = [];
  if (config.TELEGRAM_BOT_TOKEN_GASTOS) {
    bots.push({ templateId: 'gastos', token: config.TELEGRAM_BOT_TOKEN_GASTOS });
  }
  if (config.TELEGRAM_BOT_TOKEN_KIOSCO) {
    bots.push({ templateId: 'kiosco', token: config.TELEGRAM_BOT_TOKEN_KIOSCO });
  }
  if (bots.length === 0) {
    throw new ConfigError(
      'No hay ningún bot configurado. Definí al menos TELEGRAM_BOT_TOKEN_<VERTICAL> (ej. TELEGRAM_BOT_TOKEN_KIOSCO).'
    );
  }
  return bots;
}
