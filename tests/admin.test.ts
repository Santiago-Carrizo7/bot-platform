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
  makeBusiness,
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

describe('admin: lista y alta de negocios', () => {
  it('sin negocios muestra el estado vacío y el formulario de alta', async () => {
    const app = await startApp();
    const { cookie } = await login(app.base, PASSWORD);
    const res = await fetch(`${app.base}/admin/`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Todavía no hay negocios');
    expect(html).toContain('Crear negocio');
    expect(html).toContain('Control de Gastos (gastos)');
    expect(html).toContain('Salir');
  });

  it('crear negocio: crea, corre el seed, audita y redirige al detalle', async () => {
    const app = await startApp();
    const { cookie } = await login(app.base, PASSWORD);
    const seeds: string[] = [];
    app.deps.seedBusiness = async (templateId, businessId) => {
      seeds.push(`${templateId}:${businessId}`);
    };

    const res = await post(
      `${app.base}/admin/businesses`,
      { name: 'Kiosco Don Pepe', templateId: 'gastos' },
      formHeaders(app.base, { Cookie: cookie })
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;

    const created = [...app.repos.businesses.store.values()];
    expect(created).toHaveLength(1);
    expect(created[0].name).toBe('Kiosco Don Pepe');
    expect(created[0].timezone).toBe('America/Argentina/Buenos_Aires');
    expect(created[0].currency).toBe('ARS');
    expect(seeds).toEqual([`gastos:${created[0].id}`]);
    expect(location).toBe(`/admin/businesses/${created[0].id}`);
    expect(app.repos.audit.entries.map((e) => e.action)).toContain('admin.business_created');
    expect(app.repos.audit.entries[0].actorUserId).toBeNull();

    const detail = await fetch(`${app.base}${location}`, { headers: { Cookie: cookie } });
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain('Kiosco Don Pepe');
  });

  it('template desconocido → 400 con el error en el formulario (no crea nada)', async () => {
    const app = await startApp();
    const { cookie } = await login(app.base, PASSWORD);
    const res = await post(
      `${app.base}/admin/businesses`,
      { name: 'Otro', templateId: 'no-existe' },
      formHeaders(app.base, { Cookie: cookie })
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Template desconocido');
    expect(app.repos.businesses.store.size).toBe(0);
  });

  it('nombre vacío → 400 y sigue en la lista', async () => {
    const app = await startApp();
    const { cookie } = await login(app.base, PASSWORD);
    const res = await post(
      `${app.base}/admin/businesses`,
      { name: '   ', templateId: 'gastos' },
      formHeaders(app.base, { Cookie: cookie })
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Ingresá un nombre');
    expect(app.repos.businesses.store.size).toBe(0);
  });

  it('lista los negocios existentes con estado y trial', async () => {
    const app = await startApp();
    app.repos.businesses.seed({ ...makeBusiness({ name: 'Panadería Luna', status: 'ACTIVE' }) });
    app.repos.businesses.seed({
      ...makeBusiness({
        name: 'Barbería Cut',
        status: 'TRIAL',
        trialStartedAt: new Date(Date.now() - 2 * 86_400_000),
        trialDays: 10,
      }),
    });
    const { cookie } = await login(app.base, PASSWORD);
    const html = await (await fetch(`${app.base}/admin/`, { headers: { Cookie: cookie } })).text();
    expect(html).toContain('Panadería Luna');
    expect(html).toContain('Barbería Cut');
    expect(html).toContain('trial 8 d');
    expect(html).toContain('activo');
  });
});

describe('admin: detalle de negocio', () => {
  it('muestra datos, miembros (telegramId + rol) e invitaciones con estado', async () => {
    const app = await startApp();
    const business = app.repos.businesses.seed(makeBusiness({ name: 'Kiosco Detalle', timezone: 'UTC' }));
    const user = await app.repos.users.create('555000111');
    await app.repos.memberships.create({ businessId: business.id, userId: user.id, role: 'OWNER' });

    const pending = await app.deps.invitations.create(business.id, 'EMPLOYEE', { botUsername: 'mi_bot_test' });
    const revoked = await app.deps.invitations.create(business.id, 'OWNER', { botUsername: 'mi_bot_test' });
    await app.deps.invitations.revoke(business.id, revoked.invitation.id, 'owner-1');

    const { cookie } = await login(app.base, PASSWORD);
    const res = await fetch(`${app.base}/admin/businesses/${business.id}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('Kiosco Detalle');
    expect(html).toContain(business.id);
    expect(html).toContain('555000111');
    expect(html).toContain('OWNER');
    expect(html).toContain('pendiente');
    expect(html).toContain('revocada');
    expect(html).toContain('Miembros (1)');
    expect(html).toContain('Invitaciones (2)');
    // El deep link NUNCA se muestra de nuevo (solo el hash vive en la DB).
    expect(html).not.toContain(pending.token);
  });

  it('negocio inexistente → 404', async () => {
    const app = await startApp();
    const { cookie } = await login(app.base, PASSWORD);
    const res = await fetch(`${app.base}/admin/businesses/no-existe`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('NOT_FOUND');
  });
});

describe('admin: invitaciones, miembros y estado', () => {
  async function businessFixture(app: TestApp) {
    const business = app.repos.businesses.seed(makeBusiness({ name: 'Negocio Ops' }));
    const user = await app.repos.users.create('777888999');
    await app.repos.memberships.create({ businessId: business.id, userId: user.id, role: 'OWNER' });
    return { business, user };
  }

  it('crear invitación: devuelve el deep link UNA sola vez y queda registrada', async () => {
    const app = await startApp();
    const { business } = await businessFixture(app);
    const { cookie } = await login(app.base, PASSWORD);

    const res = await post(
      `${app.base}/admin/businesses/${business.id}/invitations`,
      { role: 'EMPLOYEE', days: '5' },
      formHeaders(app.base, { Cookie: cookie })
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('https://t.me/mi_bot_test?start=');
    expect(html).toContain('se muestra una sola vez');
    const shownToken = html.split('https://t.me/mi_bot_test?start=')[1]?.split(/["<]/)[0];
    expect(shownToken).toBeTruthy();

    const invitation = [...app.repos.invitations.store.values()][0];
    expect(invitation.role).toBe('EMPLOYEE');
    expect(invitation.expiresAt.getTime()).toBeGreaterThan(Date.now() + 4 * 86_400_000);
    // En la DB vive solo el hash, nunca el token.
    expect(invitation.tokenHash).not.toBe(shownToken);
    expect(app.repos.audit.entries.map((e) => e.action)).toContain('admin.invitation_created');

    // Volver al detalle: el deep link ya no aparece.
    const detail = await (
      await fetch(`${app.base}/admin/businesses/${business.id}`, { headers: { Cookie: cookie } })
    ).text();
    expect(detail).not.toContain(shownToken!);
  });

  it('sin bot configurado para el template → error amigable, sin crear invitación', async () => {
    const app = await startApp();
    const { business } = await businessFixture(app);
    app.deps.resolveBotUsername = async () => {
      throw new Error("No hay bot configurado para 'gastos'. Configurá TELEGRAM_BOT_TOKEN_GASTOS.");
    };
    const { cookie } = await login(app.base, PASSWORD);
    const res = await post(
      `${app.base}/admin/businesses/${business.id}/invitations`,
      { role: 'OWNER', days: '7' },
      formHeaders(app.base, { Cookie: cookie })
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('TELEGRAM_BOT_TOKEN_GASTOS');
    expect(app.repos.invitations.store.size).toBe(0);
  });

  it('días fuera de rango → 400 con el mensaje en el detalle', async () => {
    const app = await startApp();
    const { business } = await businessFixture(app);
    const { cookie } = await login(app.base, PASSWORD);
    const res = await post(
      `${app.base}/admin/businesses/${business.id}/invitations`,
      { role: 'OWNER', days: '400' },
      formHeaders(app.base, { Cookie: cookie })
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('hasta 90 días');
    expect(app.repos.invitations.store.size).toBe(0);
  });

  it('revocar invitación: cambia el estado, audita y redirige al detalle', async () => {
    const app = await startApp();
    const { business } = await businessFixture(app);
    const created = await app.deps.invitations.create(business.id, 'EMPLOYEE', { botUsername: 'mi_bot_test' });
    const { cookie } = await login(app.base, PASSWORD);

    const res = await post(
      `${app.base}/admin/invitations/${created.invitation.id}/revoke`,
      {},
      formHeaders(app.base, { Cookie: cookie })
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/admin/businesses/${business.id}`);
    expect((await app.repos.invitations.findById(created.invitation.id))?.revokedAt).not.toBeNull();
    expect(app.repos.audit.entries.map((e) => e.action)).toContain('admin.invitation_revoked');
    expect(app.repos.audit.entries.at(-1)?.actorUserId).toBeNull();
  });

  it('invitación inexistente → 404', async () => {
    const app = await startApp();
    const { cookie } = await login(app.base, PASSWORD);
    const res = await post(`${app.base}/admin/invitations/no-existe/revoke`, {}, formHeaders(app.base, { Cookie: cookie }));
    expect(res.status).toBe(404);
  });

  it('cambiar estado manual: audita de → a y refleja el cambio', async () => {
    const app = await startApp();
    const { business } = await businessFixture(app);
    const { cookie } = await login(app.base, PASSWORD);
    const from = business.status;

    const res = await post(
      `${app.base}/admin/businesses/${business.id}/status`,
      { status: 'SUSPENDED' },
      formHeaders(app.base, { Cookie: cookie })
    );
    expect(res.status).toBe(302);
    expect((await app.repos.businesses.findById(business.id))?.status).toBe('SUSPENDED');

    const change = app.repos.audit.entries.find((e) => e.action === 'admin.status_changed');
    expect(change?.metadata).toMatchObject({ from, to: 'SUSPENDED' });
    expect(change?.actorUserId).toBeNull();

    const html = await (await fetch(`${app.base}/admin/businesses/${business.id}`, { headers: { Cookie: cookie } })).text();
    expect(html).toContain('SUSPENDED');
    expect(html).toContain('suspendido');
  });

  it('estado fuera del enum → 400 y el negocio queda igual', async () => {
    const app = await startApp();
    const { business } = await businessFixture(app);
    const { cookie } = await login(app.base, PASSWORD);
    const res = await post(
      `${app.base}/admin/businesses/${business.id}/status`,
      { status: 'REBOOT' },
      formHeaders(app.base, { Cookie: cookie })
    );
    expect(res.status).toBe(400);
    expect((await app.repos.businesses.findById(business.id))?.status).toBe('TRIAL');
  });

  it('flujo completo: crear negocio → invitar owner → revocar → suspender', async () => {
    const app = await startApp();
    const { cookie } = await login(app.base, PASSWORD);

    const created = await post(
      `${app.base}/admin/businesses`,
      { name: 'Barbería Norte', templateId: 'gastos' },
      formHeaders(app.base, { Cookie: cookie })
    );
    const detailUrl = created.headers.get('location')!;

    const invite = await post(
      `${app.base}${detailUrl}/invitations`,
      { role: 'OWNER', days: '7' },
      formHeaders(app.base, { Cookie: cookie })
    );
    const html = await invite.text();
    expect(html).toContain('https://t.me/mi_bot_test?start=');
    const invitationId = [...app.repos.invitations.store.values()][0].id;

    const revoke = await post(
      `${app.base}/admin/invitations/${invitationId}/revoke`,
      {},
      formHeaders(app.base, { Cookie: cookie })
    );
    expect(revoke.status).toBe(302);

    const status = await post(
      `${app.base}${detailUrl}/status`,
      { status: 'READ_ONLY' },
      formHeaders(app.base, { Cookie: cookie })
    );
    expect(status.status).toBe(302);

    const actions = app.repos.audit.entries.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'admin.business_created',
        'admin.invitation_created',
        'admin.invitation_revoked',
        'admin.status_changed',
      ])
    );
    expect(app.repos.audit.entries.every((e) => e.actorUserId === null)).toBe(true);
  });
});
