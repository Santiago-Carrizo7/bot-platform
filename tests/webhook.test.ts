import { describe, expect, it } from 'vitest';
import { Bot } from 'grammy';
import { buildTelegramWebhookRoutes } from '../src/infrastructure/telegram/bot.js';

const FAKE_TOKEN = '123456:fake-token-para-tests-ABCDEF1234567890';

describe('webhook de Telegram', () => {
  it('una ruta POST por bot: /telegram/<templateId>', () => {
    const routes = buildTelegramWebhookRoutes(
      [
        { templateId: 'kiosco', bot: new Bot(FAKE_TOKEN) },
        { templateId: 'gastos', bot: new Bot(FAKE_TOKEN) },
      ],
      'secreto-de-webhook-largo'
    );
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({ method: 'post', path: '/telegram/kiosco' });
    expect(routes[1]).toMatchObject({ method: 'post', path: '/telegram/gastos' });
    expect(typeof routes[0].handler).toBe('function');
  });

  it('sin bots no hay rutas', () => {
    expect(buildTelegramWebhookRoutes([], 'secreto-de-webhook-largo')).toEqual([]);
  });
});
