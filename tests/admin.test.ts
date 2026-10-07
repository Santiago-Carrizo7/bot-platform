import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  ADMIN_SESSION_COOKIE,
  buildClearCookie,
  buildSessionCookie,
  passwordFingerprint,
  readCookie,
  signSession,
  verifySession,
} from '../src/app/admin/session.js';
import { createAdminRouter, type AdminRouterDeps } from '../src/app/admin/router.js';
import { createExpressApp } from '../src/infrastructure/http/server.js';
import { AuditService } from '../src/core/audit/audit.service.js';
import { InvitationService } from '../src/core/identity/invitation.service.js';
import { MembershipService } from '../src/core/identity/membership.service.js';
import { UserService } from '../src/core/identity/user.service.js';
import { BusinessService } from '../src/core/tenant/business.service.js';
import {
  FakeAuditRepo,
  FakeBusinessRepo,
  FakeInvitationRepo,
  FakeMembershipRepo,
  FakeUserRepo,
} from './fakes.js';

const PASSWORD = 'password-de-admin-super-larga';
const SECRET = 'secreto-de-prueba-muy-largo-123';

describe('admin session (cookie firmada HMAC)', () => {
  it('firma y verifica con la misma password y secret', () => {
    const value = signSession({ password: PASSWORD, secret: SECRET });
    const payload = verifySession(value, { password: PASSWORD, secret: SECRET });
    expect(payload).not.toBeNull();
    expect(payload!.exp).toBeGreaterThan(Date.now());
    expect(payload!.pwdFp).toBe(passwordFingerprint(PASSWORD));
  });

  it('expira según el TTL (12 h)', () => {
    const now = new Date('2026-10-07T10:00:00Z');
    const value = signSession({ password: PASSWORD, secret: SECRET, now });
    const afterTtl = new Date(now.getTime() + 12 * 3600_000 + 1000);
    expect(verifySession(value, { password: PASSWORD, secret: SECRET, now: afterTtl })).toBeNull();
    const beforeTtl = new Date(now.getTime() + 3600_000);
    expect(verifySession(value, { password: PASSWORD, secret: SECRET, now: beforeTtl })).not.toBeNull();
  });

  it('cookie tampeada (body o firma) es rechazada', () => {
    const value = signSession({ password: PASSWORD, secret: SECRET });
    const [body, signature] = value.split('.');
    expect(verifySession(`${body}x.${signature}`, { password: PASSWORD, secret: SECRET })).toBeNull();
    expect(verifySession(`${body}.${signature}x`, { password: PASSWORD, secret: SECRET })).toBeNull();
    expect(verifySession('garbage.sin-firma', { password: PASSWORD, secret: SECRET })).toBeNull();
    expect(verifySession(undefined, { password: PASSWORD, secret: SECRET })).toBeNull();
    expect(verifySession('', { password: PASSWORD, secret: SECRET })).toBeNull();
  });

  it('firmada con otro secret → inválida', () => {
    const value = signSession({ password: PASSWORD, secret: 'otro-secret-bien-largo-123' });
    expect(verifySession(value, { password: PASSWORD, secret: SECRET })).toBeNull();
  });

  it('rotar la password invalida todas las sesiones vigentes', () => {
    const value = signSession({ password: PASSWORD, secret: SECRET });
    expect(verifySession(value, { password: 'otra-password-larga-1234', secret: SECRET })).toBeNull();
  });

  it('fingerprint: corto, estable y distinto por password', () => {
    expect(passwordFingerprint(PASSWORD)).toBe(passwordFingerprint(PASSWORD));
    expect(passwordFingerprint(PASSWORD)).not.toBe(passwordFingerprint('otra-password-larga-1234'));
    expect(passwordFingerprint(PASSWORD)).toHaveLength(8);
  });

  it('cookie de sesión: HttpOnly + SameSite=Strict + Path=/admin + Max-Age 12 h', () => {
    const cookie = buildSessionCookie('valor.firma');
    expect(cookie).toContain(`${ADMIN_SESSION_COOKIE}=valor.firma`);
    expect(cookie).toContain('Path=/admin');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Max-Age=43200');
    expect(cookie).not.toContain('Secure');
    expect(buildSessionCookie('valor.firma', { secure: true })).toContain('Secure');
    expect(buildClearCookie()).toContain('Max-Age=0');
  });

  it('readCookie parsea el header', () => {
    expect(readCookie(`otra=1; ${ADMIN_SESSION_COOKIE}=abc.def; x=2`, ADMIN_SESSION_COOKIE)).toBe('abc.def');
    expect(readCookie('otra=1', ADMIN_SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(undefined, ADMIN_SESSION_COOKIE)).toBeUndefined();
  });
});

// --- Infra de tests HTTP: app Express real + fetch (sin dependencias extra) ---

interface TestApp {
  base: string;
  deps: AdminRouterDeps;
  repos: {
    businesses: FakeBusinessRepo;
    memberships: FakeMembershipRepo;
    users: FakeUserRepo;
    invitations: FakeInvitationRepo;
    audit: FakeAuditRepo;
  };
}

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function startApp(options: { admin?: boolean } = {}): Promise<TestApp> {
  const businesses = new FakeBusinessRepo();
  const memberships = new FakeMembershipRepo(businesses);
  const users = new FakeUserRepo();
  const invitations = new FakeInvitationRepo();
  const audit = new FakeAuditRepo();
  const auditService = new AuditService(audit);

  const deps: AdminRouterDeps = {
    password: PASSWORD,
    apiSecret: SECRET,
    businesses: new BusinessService(businesses),
    memberships: new MembershipService(memberships),
    users: new UserService(users),
    invitations: new InvitationService(invitations, auditService),
    audit: auditService,
    templates: [{ id: 'gastos', label: 'Control de Gastos' }],
    seedBusiness: async () => {},
    resolveBotUsername: async () => 'mi_bot_test',
  };

  const app = createExpressApp({
    memberships: deps.memberships,
    users: deps.users,
    apiSecret: SECRET,
    adminRouter: options.admin === false ? undefined : createAdminRouter(deps),
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  openServers.push(server);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    deps,
    repos: { businesses, memberships, users, invitations, audit },
  };
}

function formHeaders(base: string, extra: Record<string, string> = {}): Record<string, string> {
  // Origin igual al host: el admin solo acepta POST del mismo origen.
  return { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base, ...extra };
}

function post(url: string, body: Record<string, string>, headers: Record<string, string>): Promise<Response> {
  return fetch(url, { method: 'POST', headers, body: new URLSearchParams(body), redirect: 'manual' });
}

async function login(base: string, password: string): Promise<{ status: number; cookie: string; setCookie: string }> {
  const res = await post(`${base}/admin/login`, { password }, formHeaders(base));
  const setCookie = res.headers.get('set-cookie') ?? '';
  return { status: res.status, cookie: setCookie.split(';')[0], setCookie };
}

describe('admin: guard y login', () => {
  it('sin cookie → 302 a /admin/login', async () => {
    const app = await startApp();
    const res = await fetch(`${app.base}/admin/`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
  });

  it('POST protegido sin cookie → 302 al login', async () => {
    const app = await startApp();
    const res = await post(`${app.base}/admin/businesses`, { name: 'x', templateId: 'gastos' }, formHeaders(app.base));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
  });

  it('login correcto → cookie firmada + 302 al panel, y con la cookie /admin/ responde 200', async () => {
    const app = await startApp();
    const ok = await login(app.base, PASSWORD);
    expect(ok.status).toBe(302);
    expect(ok.cookie).toContain(`${ADMIN_SESSION_COOKIE}=`);
    expect(ok.setCookie).toContain('HttpOnly');
    expect(ok.setCookie).toContain('SameSite=Strict');
    expect(ok.setCookie).toContain('Path=/admin');
    expect(ok.setCookie).toContain('Max-Age=43200');

    const panel = await fetch(`${app.base}/admin/`, { headers: { Cookie: ok.cookie }, redirect: 'manual' });
    expect(panel.status).toBe(200);

    const toLogin = await fetch(`${app.base}/admin/login`, { headers: { Cookie: ok.cookie }, redirect: 'manual' });
    expect(toLogin.status).toBe(302);
    expect(toLogin.headers.get('location')).toBe('/admin/');
  });

  it('login incorrecto → 401 con el form y sin exponer la password', async () => {
    const app = await startApp();
    const res = await post(`${app.base}/admin/login`, { password: 'otra-cosa' }, formHeaders(app.base));
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain('Password incorrecta');
    expect(html).not.toContain(PASSWORD);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('sexto fallo en 10 min → 429 (rate limit por IP)', async () => {
    const app = await startApp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await post(`${app.base}/admin/login`, { password: `intento-${i}` }, formHeaders(app.base));
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });

  it('sin ADMIN_PASSWORD (sin router) → /admin responde 404', async () => {
    const app = await startApp({ admin: false });
    expect((await fetch(`${app.base}/admin/`)).status).toBe(404);
    expect((await fetch(`${app.base}/admin/login`)).status).toBe(404);
    // El resto de la app sigue respondiendo.
    expect((await fetch(`${app.base}/health`)).status).toBe(200);
  });

  it('POST con Origin externo → 403', async () => {
    const app = await startApp();
    const res = await post(
      `${app.base}/admin/login`,
      { password: PASSWORD },
      formHeaders(app.base, { Origin: 'http://evil.example' })
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('FORBIDDEN');
  });

  it('logout borra la cookie (Max-Age=0) y manda al login', async () => {
    const app = await startApp();
    const ok = await login(app.base, PASSWORD);
    const res = await post(`${app.base}/admin/logout`, {}, formHeaders(app.base, { Cookie: ok.cookie }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
