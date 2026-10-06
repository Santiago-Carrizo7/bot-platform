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

  it('webhook: la URL exige secret, y sin URL no pide nada', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, TELEGRAM_WEBHOOK_URL: 'https://mi-app.onrender.com' } as NodeJS.ProcessEnv)
    ).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    const config = loadConfig({
      ...BASE_ENV,
      TELEGRAM_WEBHOOK_URL: 'https://mi-app.onrender.com',
      TELEGRAM_WEBHOOK_SECRET: 'secreto-largo-de-webhook',
    } as NodeJS.ProcessEnv);
    expect(config.TELEGRAM_WEBHOOK_URL).toBe('https://mi-app.onrender.com');
    expect(loadConfig({ ...BASE_ENV } as NodeJS.ProcessEnv).TELEGRAM_WEBHOOK_URL).toBeUndefined();
  });

  it('TELEGRAM_POLLING: on por defecto, off para desarrollo local sin Telegram', () => {
    expect(loadConfig({ ...BASE_ENV } as NodeJS.ProcessEnv).TELEGRAM_POLLING).toBe('on');
    expect(
      loadConfig({ ...BASE_ENV, TELEGRAM_POLLING: 'off' } as NodeJS.ProcessEnv).TELEGRAM_POLLING
    ).toBe('off');
  });
});
