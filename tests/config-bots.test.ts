import { describe, expect, it } from 'vitest';
import { configuredBots, loadConfig } from '../src/core/config/config.js';

const BASE_ENV = {
  NODE_ENV: 'test',
  PORT: '3000',
  API_SECRET: 'secreto-de-prueba-muy-largo-123',
  DATABASE_URL: 'postgresql://localhost:5432/test',
  OPENROUTER_API_KEY: 'key-fake',
};

describe('configuredBots', () => {
  it('arranca solo con kiosco si gastos no tiene token (staging actual)', () => {
    const config = loadConfig({ ...BASE_ENV, TELEGRAM_BOT_TOKEN_KIOSCO: 'token-kiosco' } as NodeJS.ProcessEnv);
    expect(configuredBots(config)).toEqual([{ templateId: 'kiosco', token: 'token-kiosco' }]);
  });

  it('incluye todos los bots con token válido', () => {
    const config = loadConfig({
      ...BASE_ENV,
      TELEGRAM_BOT_TOKEN_GASTOS: 'token-gastos',
      TELEGRAM_BOT_TOKEN_KIOSCO: 'token-kiosco',
    } as NodeJS.ProcessEnv);
    expect(configuredBots(config)).toHaveLength(2);
  });

  it('sin ningún bot: error claro en lugar de arrancar a medias', () => {
    const config = loadConfig({ ...BASE_ENV } as NodeJS.ProcessEnv);
    expect(() => configuredBots(config)).toThrow(/ningún bot configurado/);
  });

  it('token vacío se rechaza en la validación de env', () => {
    expect(() => loadConfig({ ...BASE_ENV, TELEGRAM_BOT_TOKEN_GASTOS: '' } as NodeJS.ProcessEnv)).toThrow();
  });
});
