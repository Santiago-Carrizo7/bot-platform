import { describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createExpressApp } from '../src/infrastructure/http/server.js';
import { FakeMembershipRepo, FakeUserRepo } from './fakes.js';
import { MembershipService } from '../src/core/identity/membership.service.js';
import { UserService } from '../src/core/identity/user.service.js';

function startApp(healthCheck?: () => Promise<void | boolean>): Promise<{ base: string; close: () => Promise<void> }> {
  const users = new UserService(new FakeUserRepo());
  const memberships = new MembershipService(new FakeMembershipRepo());
  const app = createExpressApp({
    users,
    memberships,
    apiSecret: 'secret-123456789012345678901234567890',
    healthCheck,
  });

  return new Promise((resolve) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('OPS-01: Healthcheck con verificación de base de datos', () => {
  it('responde 200 OK y database: connected cuando la BD responde', async () => {
    const app = await startApp(async () => {
      // simula SELECT 1 exitoso
      return true;
    });
    try {
      const res = await fetch(`${app.base}/health`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toMatchObject({
        status: 'ok',
        database: 'connected',
      });
    } finally {
      await app.close();
    }
  });

  it('responde 503 Service Unavailable y database: disconnected cuando la BD falla', async () => {
    const app = await startApp(async () => {
      throw new Error('Connection to database timed out');
    });
    try {
      const res = await fetch(`${app.base}/health`);
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json).toEqual({
        status: 'error',
        database: 'disconnected',
      });
    } finally {
      await app.close();
    }
  });

  it('responde 200 OK cuando no hay healthCheck inyectado', async () => {
    const app = await startApp(undefined);
    try {
      const res = await fetch(`${app.base}/health`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe('ok');
    } finally {
      await app.close();
    }
  });
});
