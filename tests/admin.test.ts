import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  ADMIN_SESSION_COOKIE,
  buildClearCookie,
  buildSessionCookie,
  csrfToken,
  passwordFingerprint,
  readCookie,
  sanitizeOperator,
  signSession,
  verifySession,
} from '../src/app/admin/session.js';
import { createAdminRouter, type AdminRouterDeps } from '../src/app/admin/router.js';
import { trialLabel } from '../src/app/admin/pages.js';
import { evaluateAccess } from '../src/core/tenant/business-status.js';
import { createExpressApp } from '../src/infrastructure/http/server.js';
import { AuditService } from '../src/core/audit/audit.service.js';
import { PaymentService } from '../src/core/billing/payment.service.js';
import { InvitationService } from '../src/core/identity/invitation.service.js';
import { MembershipService } from '../src/core/identity/membership.service.js';
import { UserService } from '../src/core/identity/user.service.js';
import { BusinessService } from '../src/core/tenant/business.service.js';
import {
  FakeAuditRepo,
  FakeBusinessRepo,
  FakeInvitationRepo,
  FakeMembershipRepo,
  FakePaymentRepo,
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

  it('lleva la etiqueta del operador firmada', () => {
    const value = signSession({ password: PASSWORD, secret: SECRET, operator: 'santi' });
    expect(verifySession(value, { password: PASSWORD, secret: SECRET })?.op).toBe('santi');
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

  it('csrfToken es estable por sesión y distinto por sesión/secret', () => {
    const a = signSession({ password: PASSWORD, secret: SECRET, now: new Date('2026-10-12T10:00:00Z') });
    const b = signSession({ password: PASSWORD, secret: SECRET, now: new Date('2026-10-12T10:00:01Z') });
    expect(csrfToken(a, SECRET)).toBe(csrfToken(a, SECRET));
    expect(csrfToken(a, SECRET)).not.toBe(csrfToken(b, SECRET));
    expect(csrfToken(a, SECRET)).not.toBe(csrfToken(a, 'otro-secret-bien-largo-123'));
  });

  it('sanitizeOperator acepta nombres simples y rechaza basura', () => {
    expect(sanitizeOperator('santi')).toBe('santi');
    expect(sanitizeOperator('  María López  ')).toBe('María López');
    expect(sanitizeOperator('')).toBeUndefined();
    expect(sanitizeOperator('   ')).toBeUndefined();
    expect(sanitizeOperator('<script>')).toBeUndefined();
    expect(sanitizeOperator('a'.repeat(50))).toHaveLength(24);
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
    payments: FakePaymentRepo;
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
  const payments = new FakePaymentRepo();
  const auditService = new AuditService(audit);

  const deps: AdminRouterDeps = {
    password: PASSWORD,
    apiSecret: SECRET,
    businesses: new BusinessService(businesses),
    memberships: new MembershipService(memberships),
    users: new UserService(users),
    invitations: new InvitationService(invitations, auditService),
    audit: auditService,
    payments: new PaymentService(payments),
    trialDaysDefault: 10,
    graceDaysDefault: 7,
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
    repos: { businesses, memberships, users, invitations, audit, payments },
  };
}

function formHeaders(base: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base, ...extra };
}

function post(url: string, body: Record<string, string>, headers: Record<string, string>): Promise<Response> {
  return fetch(url, { method: 'POST', headers, body: new URLSearchParams(body), redirect: 'manual' });
}

async function login(base: string, password: string, operator?: string): Promise<{ status: number; cookie: string; csrf: string; setCookie: string }> {
  const body: Record<string, string> = { password };
  if (operator) body.operator = operator;
  const res = await post(`${base}/admin/login`, body, formHeaders(base));
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  const raw = cookie.split('=')[1] ?? '';
  return { status: res.status, cookie, csrf: raw ? csrfToken(raw, SECRET) : '', setCookie };
}

function authed(base: string, cookie: string, csrf: string, extra: Record<string, string> = {}): Record<string, string> {
  return formHeaders(base, { Cookie: cookie, ...extra });
}

describe('admin: guard y login', () => {
  it('incluye cabeceras de seguridad HTTP básicas de helmet (X-Content-Type-Options, etc.)', async () => {
    const app = await startApp();
    const res = await fetch(`${app.base}/health`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('sin cookie → 302 a /admin/login', async () => {
    const app = await startApp();
    const res = await fetch(`${app.base}/admin/`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
  });

  it('rutas nuevas sin sesión → 302 al login', async () => {
    const app = await startApp();
    for (const path of ['/admin/businesses', '/admin/trials', '/admin/payments', '/admin/audit', '/admin/config']) {
      const res = await fetch(`${app.base}${path}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
    }
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

  it('login con operador muestra la etiqueta y la audita', async () => {
    const app = await startApp();
    const ok = await login(app.base, PASSWORD, 'santi');
    expect(ok.status).toBe(302);
    const html = await (await fetch(`${app.base}/admin/`, { headers: { Cookie: ok.cookie } })).text();
    expect(html).toContain('santi');
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

  it('POST con sesión pero sin CSRF → 403', async () => {
    const app = await startApp();
    const { cookie } = await login(app.base, PASSWORD);
    const res = await post(
      `${app.base}/admin/businesses`,
      { name: 'Sin CSRF', templateId: 'gastos' },
      formHeaders(app.base, { Cookie: cookie })
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('FORBIDDEN');
    expect(app.repos.businesses.store.size).toBe(0);
  });

  it('logout con CSRF borra la cookie (Max-Age=0) y manda al login', async () => {
    const app = await startApp();
    const ok = await login(app.base, PASSWORD);
    const res = await post(`${app.base}/admin/logout`, { _csrf: ok.csrf }, authed(app.base, ok.cookie, ok.csrf));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login');
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('logout sin CSRF → 403 y la sesión sigue válida', async () => {
    const app = await startApp();
    const ok = await login(app.base, PASSWORD);
    const res = await post(`${app.base}/admin/logout`, {}, authed(app.base, ok.cookie, ok.csrf));
    expect(res.status).toBe(403);
    const panel = await fetch(`${app.base}/admin/`, { headers: { Cookie: ok.cookie } });
    expect(panel.status).toBe(200);
  });
});

describe('admin: dashboard', () => {
  it('muestra KPIs reales, últimos negocios y actividad', async () => {
    const app = await startApp();
    app.repos.businesses.seed({ ...makeBusiness({ name: 'K1', status: 'TRIAL' }) });
    app.repos.businesses.seed({ ...makeBusiness({ name: 'K2', status: 'ACTIVE' }) });
    app.repos.businesses.seed({ ...makeBusiness({ name: 'K3', status: 'SUSPENDED' }) });
    const { cookie } = await login(app.base, PASSWORD);
    const html = await (await fetch(`${app.base}/admin/`, { headers: { Cookie: cookie } })).text();
    expect(html).toContain('Dashboard');
    expect(html).toContain('Negocios registrados');
    expect(html).toContain('K1');
    expect(html).toContain('K2');
    expect(html).toContain('Cobrado este mes');
    expect(html).toContain('Crear negocio');
    expect(html).toContain('Negocios');
    expect(html).toContain('Pagos');
    expect(html).toContain('Auditoría');
  });

  it('no inventa métricas: sin datos muestra ceros y vacíos', async () => {
    const app = await startApp();
    const { cookie } = await login(app.base, PASSWORD);
    const html = await (await fetch(`${app.base}/admin/`, { headers: { Cookie: cookie } })).text();
    expect(html).toContain('Todavía no hay negocios');
    expect(html).toContain('Sin trials por vencer');
  });
});

describe('admin: lista y alta de negocios', () => {
  it('sin negocios muestra el estado vacío y el formulario de alta', async () => {
    const app = await startApp();
    const { cookie } = await login(app.base, PASSWORD);
    const res = await fetch(`${app.base}/admin/businesses`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Todavía no hay negocios');
    expect(html).toContain('Crear negocio');
    expect(html).toContain('Control de Gastos (gastos)');
    expect(html).toContain('Salir');
  });

  it('crear negocio: crea, corre el seed, audita y redirige a la confirmación', async () => {
    const app = await startApp();
    const { cookie, csrf } = await login(app.base, PASSWORD);
    const seeds: string[] = [];
    app.deps.seedBusiness = async (templateId, businessId) => {
      seeds.push(`${templateId}:${businessId}`);
    };

    const res = await post(
      `${app.base}/admin/businesses`,
      { name: 'Kiosco Don Pepe', templateId: 'gastos', _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;

    const created = [...app.repos.businesses.store.values()];
    expect(created).toHaveLength(1);
    expect(created[0].name).toBe('Kiosco Don Pepe');
    expect(created[0].timezone).toBe('America/Argentina/Buenos_Aires');
    expect(created[0].currency).toBe('ARS');
    expect(seeds).toEqual([`gastos:${created[0].id}`]);
    expect(location).toContain(`/admin/businesses/${created[0].id}`);
    expect(location).toContain('created=1');
    expect(app.repos.audit.entries.map((e) => e.action)).toContain('admin.business_created');

    const confirm = await fetch(`${app.base}${location}`, { headers: { Cookie: cookie } });
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain('Negocio creado');
  });

  it('el alta guiada muestra el paso 1 con seeds y siguientes acciones', async () => {
    const app = await startApp();
    const { cookie } = await login(app.base, PASSWORD);
    const html = await (await fetch(`${app.base}/admin/businesses/new`, { headers: { Cookie: cookie } })).text();
    expect(html).toContain('Paso 1 de 2');
    expect(html).toContain('Después de crear');
  });

  it('template desconocido → 400 con el error en el formulario (no crea nada)', async () => {
    const app = await startApp();
    const { cookie, csrf } = await login(app.base, PASSWORD);
    const res = await post(
      `${app.base}/admin/businesses`,
      { name: 'Otro', templateId: 'no-existe', _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Template desconocido');
    expect(app.repos.businesses.store.size).toBe(0);
  });

  it('nombre vacío → 400 y sigue en la lista', async () => {
    const app = await startApp();
    const { cookie, csrf } = await login(app.base, PASSWORD);
    const res = await post(
      `${app.base}/admin/businesses`,
      { name: '   ', templateId: 'gastos', _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Ingresá un nombre');
    expect(app.repos.businesses.store.size).toBe(0);
  });

  it('lista los negocios con estado y trial (misma definición que el Core)', async () => {
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
    const html = await (await fetch(`${app.base}/admin/businesses`, { headers: { Cookie: cookie } })).text();
    expect(html).toContain('Panadería Luna');
    expect(html).toContain('Barbería Cut');
    expect(html).toContain('trial 8 d');
    expect(html).toContain('activo');
  });

  it('búsqueda y filtros acotan la lista', async () => {
    const app = await startApp();
    app.repos.businesses.seed({ ...makeBusiness({ name: 'Kiosco Pepe', status: 'TRIAL' }) });
    app.repos.businesses.seed({ ...makeBusiness({ name: 'Rotisería Ana', status: 'ACTIVE' }) });
    const { cookie } = await login(app.base, PASSWORD);
    const byName = await (
      await fetch(`${app.base}/admin/businesses?q=pepe`, { headers: { Cookie: cookie } })
    ).text();
    expect(byName).toContain('Kiosco Pepe');
    expect(byName).not.toContain('Rotisería Ana');
    const byStatus = await (
      await fetch(`${app.base}/admin/businesses?status=ACTIVE`, { headers: { Cookie: cookie } })
    ).text();
    expect(byStatus).toContain('Rotisería Ana');
    expect(byStatus).not.toContain('Kiosco Pepe');
  });

  it('XSS: el nombre con HTML se escapa en la lista', async () => {
    const app = await startApp();
    const { cookie, csrf } = await login(app.base, PASSWORD);
    await post(
      `${app.base}/admin/businesses`,
      { name: '<script>alert(1)</script>', templateId: 'gastos', _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    const html = await (await fetch(`${app.base}/admin/businesses`, { headers: { Cookie: cookie } })).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('admin: trial calculado como el Core', () => {
  it('trialLabel usa evaluateAccess (sin cálculos duplicados)', () => {
    const b = makeBusiness({ status: 'TRIAL', trialStartedAt: new Date(Date.now() - 2 * 86_400_000), trialDays: 10 });
    expect(evaluateAccess(b).trialDaysLeft).toBe(8);
    expect(trialLabel(b)).toBe('trial 8 d');
  });

  it('trial vencido → efectivo READ_ONLY + recordatorio', () => {
    const b = makeBusiness({ status: 'TRIAL', trialStartedAt: new Date(Date.now() - 11 * 86_400_000), trialDays: 10 });
    const ev = evaluateAccess(b);
    expect(ev.effectiveStatus).toBe('READ_ONLY');
    expect(ev.canWrite).toBe(false);
    expect(trialLabel(b)).toBe('trial vencido');
  });

  it('página de trials agrupa por vencer/vencidos/activos/sin usar', async () => {
    const app = await startApp();
    app.repos.businesses.seed({ ...makeBusiness({ name: 'Sin usar', status: 'TRIAL', trialStartedAt: null }) });
    app.repos.businesses.seed({
      ...makeBusiness({ name: 'Por vencer', status: 'TRIAL', trialStartedAt: new Date(Date.now() - 9 * 86_400_000), trialDays: 10 }),
    });
    const { cookie } = await login(app.base, PASSWORD);
    const html = await (await fetch(`${app.base}/admin/trials`, { headers: { Cookie: cookie } })).text();
    expect(html).toContain('Sin usar');
    expect(html).toContain('Por vencer');
    expect(html).toContain('Trials y suscripciones');
  });
});

describe('admin: detalle de negocio', () => {
  it('resumen muestra datos, último pago y total cobrado', async () => {
    const app = await startApp();
    const business = app.repos.businesses.seed(makeBusiness({ name: 'Kiosco Detalle', timezone: 'UTC' }));
    const { cookie } = await login(app.base, PASSWORD);
    const res = await fetch(`${app.base}/admin/businesses/${business.id}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Kiosco Detalle');
    expect(html).toContain(business.id);
    expect(html).toContain('Resumen');
    expect(html).toContain('Suscripción');
    expect(html).toContain('Pagos');
    expect(html).toContain('Actividad');
  });

  it('pestañas de miembros e invitaciones con estado', async () => {
    const app = await startApp();
    const business = app.repos.businesses.seed(makeBusiness({ name: 'Kiosco Detalle', timezone: 'UTC' }));
    const user = await app.repos.users.create('555000111');
    await app.repos.memberships.create({ businessId: business.id, userId: user.id, role: 'OWNER' });

    const pending = await app.deps.invitations.create(business.id, 'EMPLOYEE', { botUsername: 'mi_bot_test' });
    const revoked = await app.deps.invitations.create(business.id, 'OWNER', { botUsername: 'mi_bot_test' });
    await app.deps.invitations.revoke(business.id, revoked.invitation.id, 'owner-1');

    const { cookie } = await login(app.base, PASSWORD);
    const members = await (
      await fetch(`${app.base}/admin/businesses/${business.id}?tab=miembros`, { headers: { Cookie: cookie } })
    ).text();
    expect(members).toContain('555000111');
    expect(members).toContain('OWNER');

    const invites = await (
      await fetch(`${app.base}/admin/businesses/${business.id}?tab=invitaciones`, { headers: { Cookie: cookie } })
    ).text();
    expect(invites).toContain('pendiente');
    expect(invites).toContain('revocada');
    expect(invites).toContain('Miembros (1)');
    expect(invites).toContain('Invitaciones (2)');
    expect(invites).not.toContain(pending.token);
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
    const { cookie, csrf } = await login(app.base, PASSWORD);

    const res = await post(
      `${app.base}/admin/businesses/${business.id}/invitations`,
      { role: 'EMPLOYEE', days: '5', _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('https://t.me/mi_bot_test?start=');
    expect(html).toContain('se muestra una sola vez');
    expect(html).toContain('Copiar enlace');
    const shownToken = html.split('https://t.me/mi_bot_test?start=')[1]?.split(/["<]/)[0];
    expect(shownToken).toBeTruthy();

    const invitation = [...app.repos.invitations.store.values()][0];
    expect(invitation.role).toBe('EMPLOYEE');
    expect(invitation.expiresAt.getTime()).toBeGreaterThan(Date.now() + 4 * 86_400_000);
    expect(invitation.tokenHash).not.toBe(shownToken);
    expect(app.repos.audit.entries.map((e) => e.action)).toContain('admin.invitation_created');

    const detail = await (
      await fetch(`${app.base}/admin/businesses/${business.id}?tab=invitaciones`, { headers: { Cookie: cookie } })
    ).text();
    expect(detail).not.toContain(shownToken!);
  });

  it('sin bot configurado para el template → error amigable, sin crear invitación', async () => {
    const app = await startApp();
    const { business } = await businessFixture(app);
    app.deps.resolveBotUsername = async () => {
      throw new Error("No hay bot configurado para 'gastos'. Configurá TELEGRAM_BOT_TOKEN_GASTOS.");
    };
    const { cookie, csrf } = await login(app.base, PASSWORD);
    const res = await post(
      `${app.base}/admin/businesses/${business.id}/invitations`,
      { role: 'OWNER', days: '7', _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('TELEGRAM_BOT_TOKEN_GASTOS');
    expect(app.repos.invitations.store.size).toBe(0);
  });

  it('días fuera de rango → 400 con el mensaje en el detalle', async () => {
    const app = await startApp();
    const { business } = await businessFixture(app);
    const { cookie, csrf } = await login(app.base, PASSWORD);
    const res = await post(
      `${app.base}/admin/businesses/${business.id}/invitations`,
      { role: 'OWNER', days: '400', _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('hasta 90 días');
    expect(app.repos.invitations.store.size).toBe(0);
  });

  it('revocar invitación: cambia el estado, audita y redirige al detalle', async () => {
    const app = await startApp();
    const { business } = await businessFixture(app);
    const created = await app.deps.invitations.create(business.id, 'EMPLOYEE', { botUsername: 'mi_bot_test' });
    const { cookie, csrf } = await login(app.base, PASSWORD);

    const res = await post(
      `${app.base}/admin/invitations/${created.invitation.id}/revoke`,
      { _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain(`/admin/businesses/${business.id}`);
    expect((await app.repos.invitations.findById(created.invitation.id))?.revokedAt).not.toBeNull();
    expect(app.repos.audit.entries.map((e) => e.action)).toContain('admin.invitation_revoked');
  });

  it('invitación inexistente → 404', async () => {
    const app = await startApp();
    const { cookie, csrf } = await login(app.base, PASSWORD);
    const res = await post(
      `${app.base}/admin/invitations/no-existe/revoke`,
      { _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    expect(res.status).toBe(404);
  });

  it('cambiar estado manual: audita de → a con motivo y refleja el cambio', async () => {
    const app = await startApp();
    const { business } = await businessFixture(app);
    const { cookie, csrf } = await login(app.base, PASSWORD, 'ops');
    const from = business.status;

    const res = await post(
      `${app.base}/admin/businesses/${business.id}/status`,
      { status: 'SUSPENDED', reason: 'falta de pago', _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    expect(res.status).toBe(302);
    expect((await app.repos.businesses.findById(business.id))?.status).toBe('SUSPENDED');

    const change = app.repos.audit.entries.find((e) => e.action === 'admin.status_changed');
    expect(change?.metadata).toMatchObject({ from, to: 'SUSPENDED', reason: 'falta de pago', operator: 'ops' });

    const html = await (
      await fetch(`${app.base}/admin/businesses/${business.id}?tab=suscripcion`, { headers: { Cookie: cookie } })
    ).text();
    expect(html).toContain('SUSPENDED');
    expect(html).toContain('suspendido');
  });

  it('estado fuera del enum → 400 y el negocio queda igual', async () => {
    const app = await startApp();
    const { business } = await businessFixture(app);
    const { cookie, csrf } = await login(app.base, PASSWORD);
    const res = await post(
      `${app.base}/admin/businesses/${business.id}/status`,
      { status: 'REBOOT', _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    expect(res.status).toBe(400);
    expect((await app.repos.businesses.findById(business.id))?.status).toBe('TRIAL');
  });

  it('flujo completo: crear negocio → invitar owner → revocar → suspender', async () => {
    const app = await startApp();
    const { cookie, csrf } = await login(app.base, PASSWORD);

    const created = await post(
      `${app.base}/admin/businesses`,
      { name: 'Barbería Norte', templateId: 'gastos', _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    const detailUrl = created.headers.get('location')!.split('?')[0];

    const invite = await post(
      `${app.base}${detailUrl}/invitations`,
      { role: 'OWNER', days: '7', _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    const html = await invite.text();
    expect(html).toContain('https://t.me/mi_bot_test?start=');
    const invitationId = [...app.repos.invitations.store.values()][0].id;

    const revoke = await post(
      `${app.base}/admin/invitations/${invitationId}/revoke`,
      { _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    expect(revoke.status).toBe(302);

    const status = await post(
      `${app.base}${detailUrl}/status`,
      { status: 'READ_ONLY', _csrf: csrf },
      authed(app.base, cookie, csrf)
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
  });
});

describe('admin: pagos manuales', () => {
  async function fixture(app: TestApp) {
    const business = app.repos.businesses.seed(makeBusiness({ name: 'Kiosco Pagos', currency: 'ARS' }));
    return business;
  }

  function todayInput(): string {
    return new Date().toISOString().slice(0, 10);
  }

  it('registra un pago CONFIRMED, lo muestra en el detalle y audita', async () => {
    const app = await startApp();
    const business = await fixture(app);
    const { cookie, csrf } = await login(app.base, PASSWORD, 'caja');

    const res = await post(
      `${app.base}/admin/businesses/${business.id}/payments`,
      { amount: '15000', paidAt: todayInput(), method: 'TRANSFERENCIA', status: 'CONFIRMED', concept: 'Suscripción', idempotencyKey: 'k-1', _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    expect(res.status).toBe(302);

    const stored = [...app.repos.payments.store.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0].amount).toBe(15000);
    expect(stored[0].operator).toBe('caja');
    expect(app.repos.audit.entries.map((e) => e.action)).toContain('admin.payment_registered');

    const detail = await (
      await fetch(`${app.base}/admin/businesses/${business.id}?tab=pagos`, { headers: { Cookie: cookie } })
    ).text();
    expect(detail).toContain('TRANSFERENCIA');
    expect(detail).toContain('CONFIRMED');
  });

  it('PENDING no se mezcla con lo cobrado en los totales', async () => {
    const app = await startApp();
    const business = await fixture(app);
    const { cookie, csrf } = await login(app.base, PASSWORD);
    await post(
      `${app.base}/admin/businesses/${business.id}/payments`,
      { amount: '10000', paidAt: todayInput(), method: 'EFECTIVO', status: 'CONFIRMED', idempotencyKey: 'k-c', _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    await post(
      `${app.base}/admin/businesses/${business.id}/payments`,
      { amount: '5000', paidAt: todayInput(), method: 'EFECTIVO', status: 'PENDING', idempotencyKey: 'k-p', _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    const html = await (await fetch(`${app.base}/admin/payments`, { headers: { Cookie: cookie } })).text();
    expect(html).toContain('CONFIRMED');
    expect(html).toContain('PENDING');
  });

  it('doble envío con la misma clave no duplica (idempotencia)', async () => {
    const app = await startApp();
    const business = await fixture(app);
    const { cookie, csrf } = await login(app.base, PASSWORD);
    const body = { amount: '9000', paidAt: todayInput(), method: 'EFECTIVO', status: 'CONFIRMED', idempotencyKey: 'same-key', _csrf: csrf };
    await post(`${app.base}/admin/businesses/${business.id}/payments`, body, authed(app.base, cookie, csrf));
    await post(`${app.base}/admin/businesses/${business.id}/payments`, body, authed(app.base, cookie, csrf));
    expect(app.repos.payments.store.size).toBe(1);
    expect(app.repos.audit.entries.map((e) => e.action)).toContain('admin.payment_duplicate_ignored');
  });

  it('anular marca VOID con motivo, audita y conserva el historial', async () => {
    const app = await startApp();
    const business = await fixture(app);
    const { cookie, csrf } = await login(app.base, PASSWORD);
    await post(
      `${app.base}/admin/businesses/${business.id}/payments`,
      { amount: '7000', paidAt: todayInput(), method: 'EFECTIVO', status: 'CONFIRMED', idempotencyKey: 'k-v', _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    const id = [...app.repos.payments.store.values()][0].id;
    const res = await post(
      `${app.base}/admin/payments/${id}/void`,
      { businessId: business.id, reason: 'monto erróneo', _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    expect(res.status).toBe(302);
    expect(app.repos.payments.store.get(id)?.status).toBe('VOID');
    expect(app.repos.payments.store.get(id)?.voidReason).toBe('monto erróneo');
    expect(app.repos.audit.entries.map((e) => e.action)).toContain('admin.payment_voided');
    expect(app.repos.payments.store.size).toBe(1);
  });

  it('registrar un pago CONFIRMED sin periodTo NO cambia el estado del negocio', async () => {
    const app = await startApp();
    const business = await fixture(app);
    const { cookie, csrf } = await login(app.base, PASSWORD);
    await post(
      `${app.base}/admin/businesses/${business.id}/payments`,
      { amount: '20000', paidAt: todayInput(), method: 'EFECTIVO', status: 'CONFIRMED', idempotencyKey: 'k-s', _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    expect((await app.repos.businesses.findById(business.id))?.status).toBe('TRIAL');
  });

  it('registrar un pago CONFIRMED con periodTo activa el negocio y actualiza subscriptionExpiresAt', async () => {
    const app = await startApp();
    const business = await fixture(app);
    const { cookie, csrf } = await login(app.base, PASSWORD);
    await post(
      `${app.base}/admin/businesses/${business.id}/payments`,
      {
        amount: '20000',
        paidAt: todayInput(),
        periodTo: '2026-12-31',
        method: 'TRANSFERENCIA',
        status: 'CONFIRMED',
        idempotencyKey: 'k-active',
        _csrf: csrf,
      },
      authed(app.base, cookie, csrf)
    );
    const updated = await app.repos.businesses.findById(business.id);
    expect(updated?.status).toBe('ACTIVE');
    expect(updated?.subscriptionExpiresAt).toEqual(new Date('2026-12-31T12:00:00'));
    expect(updated?.activatedAt).toBeInstanceOf(Date);
    expect(app.repos.audit.entries.map((e) => e.action)).toContain('admin.subscription_extended');
  });

  it('importe inválido → 400 sin crear nada', async () => {
    const app = await startApp();
    const business = await fixture(app);
    const { cookie, csrf } = await login(app.base, PASSWORD);
    const res = await post(
      `${app.base}/admin/businesses/${business.id}/payments`,
      { amount: 'cero', paidAt: todayInput(), method: 'EFECTIVO', status: 'CONFIRMED', idempotencyKey: 'k-x', _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    expect(res.status).toBe(400);
    expect(app.repos.payments.store.size).toBe(0);
  });
});

describe('admin: auditoría y config', () => {
  it('la auditoría global lista operaciones sensibles con operador', async () => {
    const app = await startApp();
    const { cookie, csrf } = await login(app.base, PASSWORD, 'auditor');
    await post(
      `${app.base}/admin/businesses`,
      { name: 'Auditado', templateId: 'gastos', _csrf: csrf },
      authed(app.base, cookie, csrf)
    );
    const html = await (await fetch(`${app.base}/admin/audit`, { headers: { Cookie: cookie } })).text();
    expect(html).toContain('admin.business_created');
    expect(html).toContain('auditor');
    expect(html).not.toContain(PASSWORD);
  });

  it('config muestra parámetros sin secretos', async () => {
    const app = await startApp();
    const { cookie } = await login(app.base, PASSWORD);
    const html = await (await fetch(`${app.base}/admin/config`, { headers: { Cookie: cookie } })).text();
    expect(html).toContain('Trial por defecto');
    expect(html).not.toContain('password-de-admin');
    expect(html).not.toContain('secreto-de-prueba');
  });
});
