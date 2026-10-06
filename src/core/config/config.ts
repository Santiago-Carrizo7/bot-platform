import 'dotenv/config';
import { z } from 'zod';
import { ConfigError } from '../errors/errors.js';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  API_SECRET: z.string().min(16, 'API_SECRET es obligatorio (mínimo 16 caracteres)'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatorio'),

  // Un bot por vertical (registro estático). Agregar una línea por template nuevo.
  TELEGRAM_BOT_TOKEN_GASTOS: z.string().min(1, 'TELEGRAM_BOT_TOKEN_GASTOS es obligatorio'),
  TELEGRAM_BOT_TOKEN_KIOSCO: z.string().optional(),

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
  const bots: BotBinding[] = [{ templateId: 'gastos', token: config.TELEGRAM_BOT_TOKEN_GASTOS }];
  if (config.TELEGRAM_BOT_TOKEN_KIOSCO) {
    bots.push({ templateId: 'kiosco', token: config.TELEGRAM_BOT_TOKEN_KIOSCO });
  }
  return bots;
}
