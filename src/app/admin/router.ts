import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../core/errors/errors.js';
import { logger } from '../../core/logging/logger.js';
import { evaluateAccess } from '../../core/tenant/business-status.js';
import type { AuditService } from '../../core/audit/audit.service.js';
import type { PaymentService } from '../../core/billing/payment.service.js';
import type { InvitationService } from '../../core/identity/invitation.service.js';
import type { MembershipService } from '../../core/identity/membership.service.js';
import type { UserService } from '../../core/identity/user.service.js';
import type { BusinessService } from '../../core/tenant/business.service.js';
import type { Business, ManualPayment } from '../../core/tenant/entities.js';
import {
  auditPage,
  businessCreatedPage,
  businessDetailPage,
  businessListPage,
  businessNewPage,
  configPage,
  dashboardPage,
  fmtMoney,
  invitationStatus,
  paymentsPage,
  trialDaysLeft,
  trialEndsAt,
  trialLabel,
  trialsPage,
  isTimezone,
  loginPage,
  type DetailTab,
  type InvitationView,
  type MemberView,
} from './pages.js';
import {
  ADMIN_SESSION_COOKIE,
  buildClearCookie,
  buildSessionCookie,
  csrfToken,
  readCookie,
  sanitizeOperator,
  signSession,
  verifySession,
} from './session.js';

/** 5 fallos de login cada 10 min por IP → 429 (en memoria, un solo proceso). */
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 10 * 60_000;
const PAGE_SIZE = 20;

export interface AdminTemplateOption {
  id: string;
  label: string;
}

/**
 * Todo lo que el admin necesita afuera: los servicios de Core (que no se enteran
 * de que existe la web) y los callbacks del composition root (seeds por template
 * y username del bot). El router nunca importa templates ni Telegram.
 */
export interface AdminRouterDeps {
  password: string;
  apiSecret: string;
  businesses: BusinessService;
  memberships: MembershipService;
  users: UserService;
  invitations: InvitationService;
  audit: AuditService;
  payments: PaymentService;
  trialDaysDefault: number;
  graceDaysDefault: number;
  templates: AdminTemplateOption[];
  seedBusiness: (templateId: string, businessId: string) => Promise<void>;
  resolveBotUsername: (templateId: string) => Promise<string>;
}

type Handler = (req: Request, res: Response) => Promise<void> | void;

/** Los errores salen con el mismo shape que la API (`{error, message}`). */
function route(handler: Handler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void Promise.resolve(handler(req, res)).catch(next);
  };
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function passwordMatches(submitted: string, expected: string): boolean {
  return timingSafeEqual(sha256(submitted), sha256(expected));
}

/** POST solo desde el mismo host (Origin o Referer), además de SameSite=Strict. */
function sameOrigin(req: Request): boolean {
  const source = req.headers.origin ?? req.headers.referer;
  if (!source) return true;
  try {
    return new URL(source).host === (req.headers.host ?? '');
  } catch {
    return false;
  }
}

function parseDateInput(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !raw) return null;
  const d = new Date(`${raw}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseAmount(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const n = Number(String(raw).replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > 999_999_999) return null;
  return Math.round(n * 100) / 100;
}

export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false }));

  const sessionOpts = { password: deps.password, secret: deps.apiSecret };
  const rawSessionOf = (req: Request) => readCookie(req.headers.cookie, ADMIN_SESSION_COOKIE);
  const sessionOf = (req: Request) => verifySession(rawSessionOf(req), sessionOpts);
  const csrfOf = (req: Request): string => {
    const raw = rawSessionOf(req) ?? '';
    return csrfToken(raw, deps.apiSecret);
  };
  const operatorOf = (req: Request): string | undefined => sessionOf(req)?.op;
  const secureFlag = (req: Request) => req.headers['x-forwarded-proto'] === 'https';
  const clientIp = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'desconocida';

  const failures = new Map<string, { count: number; resetAt: number }>();
  const loginFailuresOf = (ip: string, now = Date.now()) => {
    const current = failures.get(ip);
    if (!current || current.resetAt <= now) {
      const fresh = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
      failures.set(ip, fresh);
      return fresh;
    }
    return current;
  };

  router.use((req, res, next) => {
    if (req.method !== 'POST' || sameOrigin(req)) {
      next();
      return;
    }
    logger.warn('[admin] POST rechazado por origen distinto', { ip: clientIp(req), path: req.path });
    res.status(403).json({ error: 'FORBIDDEN', message: 'Origen no permitido' });
  });

  router.get(
    '/login',
    route((req, res) => {
      if (sessionOf(req)) {
        res.redirect('/admin/');
        return;
      }
      res.status(200).send(loginPage());
    })
  );

  router.post(
    '/login',
    route((req, res) => {
      const ip = clientIp(req);
      const submitted = typeof req.body?.password === 'string' ? req.body.password : '';
      const operator = sanitizeOperator(req.body?.operator);
      const window = loginFailuresOf(ip);

      if (window.count >= LOGIN_MAX_FAILURES) {
        logger.warn('[admin] Login bloqueado por rate limit', { ip });
        res.status(429).send(loginPage({ error: 'Demasiados intentos. Probá de nuevo en 10 minutos.' }));
        return;
      }
      if (!passwordMatches(submitted, deps.password)) {
        window.count += 1;
        logger.warn('[admin] Login fallido', { ip, failures: window.count });
        res.status(401).send(loginPage({ error: 'Password incorrecta.' }));
        return;
      }
      window.count = 0;
      logger.info('[admin] Login correcto', { ip, operator: operator ?? 'anónimo' });
      res.setHeader(
        'Set-Cookie',
        buildSessionCookie(signSession({ ...sessionOpts, operator }), { secure: secureFlag(req) })
      );
      res.redirect('/admin/');
    })
  );

  router.post(
    '/logout',
    route((req, res) => {
      const sess = sessionOf(req);
      if (sess) {
        const submitted = typeof req.body?._csrf === 'string' ? req.body._csrf : '';
        if (submitted !== csrfOf(req)) {
          res.status(403).json({ error: 'FORBIDDEN', message: 'CSRF inválido' });
          return;
        }
      }
      logger.info('[admin] Logout', { ip: clientIp(req), operator: sess?.op ?? 'anónimo' });
      res.setHeader('Set-Cookie', buildClearCookie({ secure: secureFlag(req) }));
      res.redirect('/admin/login');
    })
  );

  // De acá en adelante: sesión obligatoria.
  router.use((req, res, next) => {
    if (sessionOf(req)) {
      next();
      return;
    }
    res.redirect('/admin/login');
  });

  /** CSRF obligatorio en mutaciones con sesión (login/logout ya resueltos arriba). */
  router.use((req, res, next) => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    const submitted = typeof req.body?._csrf === 'string' ? req.body._csrf : '';
    if (submitted !== csrfOf(req)) {
      logger.warn('[admin] POST rechazado por CSRF inválido', { ip: clientIp(req), path: req.path });
      res.status(403).json({ error: 'FORBIDDEN', message: 'CSRF inválido. Recargá la página.' });
      return;
    }
    next();
  });

  const createBusinessSchema = z.object({
    name: z.string().trim().min(1, 'Ingresá un nombre.').max(80, 'El nombre puede tener hasta 80 caracteres.'),
    templateId: z
      .string()
      .trim()
      .refine((id) => deps.templates.some((t) => t.id === id), 'Template desconocido.'),
    timezone: z
      .string()
      .trim()
      .min(1)
      .refine(isTimezone, 'Timezone inválida (ej. America/Argentina/Buenos_Aires).')
      .default('America/Argentina/Buenos_Aires'),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, 'Moneda: 3 letras ISO 4217 (ej. ARS).')
      .transform((value) => value.toUpperCase())
      .default('ARS'),
  });

  const notFound = (res: Response, message: string) => res.status(404).json({ error: 'NOT_FOUND', message });

  const invitationSchema = z.object({
    role: z.enum(['OWNER', 'EMPLOYEE']),
    days: z.coerce
      .number({ invalid_type_error: 'Vigencia inválida.' })
      .int('La vigencia debe ser un número de días.')
      .min(1, 'La vigencia es al menos 1 día.')
      .max(90, 'La vigencia puede ser hasta 90 días.')
      .default(7),
  });

  const statusSchema = z.object({
    status: z.enum(['TRIAL', 'ACTIVE', 'READ_ONLY', 'SUSPENDED'], {
      errorMap: () => ({ message: 'Estado inválido.' }),
    }),
    reason: z.string().trim().max(120).optional().default(''),
  });

  const paymentSchema = z.object({
    businessId: z.string().min(1),
    amount: z.string().min(1, 'Ingresá un importe.'),
    paidAt: z.string().min(1, 'Ingresá la fecha de cobro.'),
    method: z.enum(['EFECTIVO', 'TRANSFERENCIA', 'MERCADO_PAGO', 'OTRO']).default('TRANSFERENCIA'),
    status: z.enum(['CONFIRMED', 'PENDING']).default('CONFIRMED'),
    concept: z.string().trim().max(80).optional().default('Suscripción'),
    notes: z.string().trim().max(200).optional().default(''),
    periodFrom: z.string().optional().default(''),
    periodTo: z.string().optional().default(''),
    idempotencyKey: z.string().optional().default(''),
  });

  const pageCtx = (req: Request) => ({ csrf: csrfOf(req), operator: operatorOf(req) });

  async function businessNameMap(): Promise<Map<string, string>> {
    const all = await deps.businesses.listAll();
    return new Map(all.map((b) => [b.id, b.name]));
  }

  /** HTML del detalle: datos + miembros + invitaciones + pagos + auditoría. */
  async function detailHtml(
    business: Business,
    req: Request,
    opts: { tab?: DetailTab; deepLink?: string; error?: string; flash?: string } = {}
  ): Promise<string> {
    const [memberships, invitations, payments, audit] = await Promise.all([
      deps.memberships.listByBusiness(business.id),
      deps.invitations.listByBusiness(business.id),
      deps.payments.listByBusiness(business.id, 100),
      deps.audit.listByBusiness(business.id, 30),
    ]);
    const members: MemberView[] = await Promise.all(
      memberships.map(async (m) => ({
        telegramId: (await deps.users.getById(m.userId))?.telegramId ?? m.userId,
        role: m.role,
        createdAt: m.createdAt,
      }))
    );
    const views: InvitationView[] = invitations.map((i) => ({
      id: i.id,
      role: i.role,
      status: invitationStatus(i),
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      usedAt: i.usedAt,
      revokedAt: i.revokedAt,
    }));
    const confirmed = payments.filter((p) => p.status === 'CONFIRMED').reduce((acc, p) => acc + p.amount, 0);
    const last = [...payments].sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime())[0] ?? null;
    return businessDetailPage({
      business,
      members,
      invitations: views,
      payments,
      paymentsTotalConfirmed: confirmed,
      lastPayment: last,
      audit,
      tab: opts.tab ?? 'resumen',
      deepLink: opts.deepLink,
      paymentFormKey: randomUUID(),
      error: opts.error,
      flash: opts.flash,
      ...pageCtx(req),
    });
  }

  async function loadDetail(
    req: Request,
    businessId: string,
    opts: { tab?: DetailTab; deepLink?: string; error?: string; flash?: string } = {}
  ): Promise<string | null> {
    const business = await deps.businesses.getById(businessId);
    return business ? detailHtml(business, req, opts) : null;
  }

  function trialBucket(b: Business, now: Date): 'pending' | 'active' | 'expiring' | 'expired' | null {
    if (b.status !== 'TRIAL') return null;
    if (!b.trialStartedAt) return 'pending';
    const left = trialDaysLeft(b, now);
    if (left === null) return 'pending';
    if (left <= 0) return 'expired';
    if (left <= 3) return 'expiring';
    return 'active';
  }

  // ------------------------------------------------------- dashboard ---
  router.get(
    '/',
    route(async (req, res) => {
      const now = new Date();
      const all = await deps.businesses.listAll();
      const totals = {
        total: all.length,
        trial: all.filter((b) => b.status === 'TRIAL').length,
        active: all.filter((b) => b.status === 'ACTIVE').length,
        readOnly: all.filter((b) => b.status === 'READ_ONLY').length,
        suspended: all.filter((b) => b.status === 'SUSPENDED').length,
      };
      const trialsExpiring = all
        .filter((b) => trialBucket(b, now) === 'expiring')
        .map((business) => ({ business, daysLeft: trialDaysLeft(business, now), endsAt: trialEndsAt(business) }))
        .sort((a, b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99))
        .slice(0, 8);
      const trialsExpired = all.filter((b) => trialBucket(b, now) === 'expired');
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const recentPayments = await deps.payments.listRecent(60);
      const monthPayments = recentPayments.filter((p) => p.paidAt >= monthStart && p.status !== 'VOID');
      const monthConfirmed = monthPayments.filter((p) => p.status === 'CONFIRMED').reduce((a, p) => a + p.amount, 0);
      const monthPending = monthPayments.filter((p) => p.status === 'PENDING').reduce((a, p) => a + p.amount, 0);
      const names = new Map(all.map((b) => [b.id, b.name] as const));
      const lastPayments = recentPayments.slice(0, 8).map((payment) => ({
        payment,
        businessName: names.get(payment.businessId) ?? payment.businessId.slice(0, 8),
      }));
      const recentAuditRaw = await deps.audit.listRecent(10);
      const recentAudit = recentAuditRaw.map((entry) => ({
        entry,
        businessName: names.get(entry.businessId) ?? entry.businessId.slice(0, 8),
      }));
      // Compat: el dashboard incluye los últimos negocios (la lista vive en /businesses).
      void fmtMoney;
      void trialLabel;
      res.status(200).send(
        dashboardPage({
          totals,
          trialsExpiring,
          trialsExpired,
          lastPayments,
          monthConfirmed,
          monthPending,
          lastBusinesses: all.slice(0, 8),
          recentAudit,
          ...pageCtx(req),
        })
      );
    })
  );

  // ------------------------------------------------- lista + filtros ---
  router.get(
    '/businesses',
    route(async (req, res) => {
      const now = new Date();
      const q = {
        q: String(req.query.q ?? ''),
        status: String(req.query.status ?? ''),
        template: String(req.query.template ?? ''),
        trial: String(req.query.trial ?? ''),
        sort: String(req.query.sort ?? 'createdAt'),
        order: String(req.query.order ?? 'desc'),
        page: String(req.query.page ?? '1'),
      };
      let all = await deps.businesses.listAll();
      const needle = q.q.trim().toLowerCase();
      if (needle) all = all.filter((b) => b.name.toLowerCase().includes(needle) || b.id.toLowerCase().includes(needle));
      if (q.status) all = all.filter((b) => b.status === q.status);
      if (q.template) all = all.filter((b) => b.templateId === q.template);
      if (q.trial) all = all.filter((b) => trialBucket(b, now) === q.trial);
      const dir = q.order === 'asc' ? 1 : -1;
      all = [...all].sort((a, b) => {
        if (q.sort === 'name') return a.name.localeCompare(b.name, 'es') * dir;
        if (q.sort === 'trialEnd') {
          const ea = trialEndsAt(a)?.getTime() ?? Number.POSITIVE_INFINITY;
          const eb = trialEndsAt(b)?.getTime() ?? Number.POSITIVE_INFINITY;
          return (ea - eb) * dir;
        }
        return (a.createdAt.getTime() - b.createdAt.getTime()) * dir;
      });
      const total = all.length;
      const page = Math.max(1, Number.parseInt(q.page, 10) || 1);
      const slice = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      res.status(200).send(
        businessListPage(slice, {
          templates: deps.templates,
          query: q,
          total,
          page,
          pageSize: PAGE_SIZE,
          ...pageCtx(req),
        })
      );
    })
  );

  router.get(
    '/businesses/new',
    route((_req, res) => {
      res.status(200).send(businessNewPage({ templates: deps.templates, ...pageCtx(_req) }));
    })
  );

  router.post(
    '/businesses',
    route(async (req, res) => {
      const ctx = pageCtx(req);
      const parsed = createBusinessSchema.safeParse(req.body);
      if (!parsed.success) {
        const message = parsed.error.issues[0]?.message ?? 'Datos inválidos.';
        const all = await deps.businesses.listAll();
        res.status(400).send(businessListPage(all.slice(0, PAGE_SIZE), { templates: deps.templates, error: message, ...ctx }));
        return;
      }
      const { name, templateId, timezone, currency } = parsed.data;
      const business = await deps.businesses.create({ name, templateId, timezone, currency });
      try {
        await deps.seedBusiness(templateId, business.id);
      } catch (error) {
        logger.error('[admin] Falló el seed del template', { templateId, businessId: business.id, error });
        const all = await deps.businesses.listAll();
        res.status(500).send(
          businessListPage(all.slice(0, PAGE_SIZE), {
            templates: deps.templates,
            error: `El negocio se creó pero falló el seed del template '${templateId}': ${
              error instanceof Error ? error.message : String(error)
            }`,
            ...ctx,
          })
        );
        return;
      }
      await deps.audit.log({
        businessId: business.id,
        actorUserId: null,
        action: 'admin.business_created',
        entityType: 'business',
        entityId: business.id,
        metadata: { templateId, name, operator: ctx.operator ?? 'anónimo' },
      });
      res.redirect(`/admin/businesses/${business.id}?created=1`);
    })
  );

  router.get(
    '/businesses/:id',
    route(async (req, res) => {
      const businessId = String(req.params.id);
      const business = await deps.businesses.getById(businessId);
      if (!business) {
        notFound(res, 'Negocio no encontrado.');
        return;
      }
      if (req.query.created === '1') {
        res.status(200).send(businessCreatedPage({ business, ...pageCtx(req) }));
        return;
      }
      const tab = (['resumen', 'suscripcion', 'miembros', 'invitaciones', 'pagos', 'actividad'] as DetailTab[]).includes(
        String(req.query.tab) as DetailTab
      )
        ? (String(req.query.tab) as DetailTab)
        : 'resumen';
      res.status(200).send(await detailHtml(business, req, { tab }));
    })
  );

  router.post(
    '/businesses/:id/invitations',
    route(async (req, res) => {
      const businessId = String(req.params.id);
      const business = await deps.businesses.getById(businessId);
      if (!business) {
        notFound(res, 'Negocio no encontrado.');
        return;
      }
      const parsed = invitationSchema.safeParse(req.body);
      if (!parsed.success) {
        const message = parsed.error.issues[0]?.message ?? 'Datos inválidos.';
        res.status(400).send(await detailHtml(business, req, { tab: 'invitaciones', error: message }));
        return;
      }
      let botUsername: string;
      try {
        botUsername = await deps.resolveBotUsername(business.templateId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('[admin] No se pudo resolver el bot para la invitación', { templateId: business.templateId, error: message });
        res.status(400).send(await detailHtml(business, req, { tab: 'invitaciones', error: message }));
        return;
      }
      const created = await deps.invitations.create(business.id, parsed.data.role, {
        ttlHours: parsed.data.days * 24,
        botUsername,
      });
      await deps.audit.log({
        businessId: business.id,
        actorUserId: null,
        action: 'admin.invitation_created',
        entityType: 'invitation',
        entityId: created.invitation.id,
        metadata: { role: parsed.data.role, days: parsed.data.days, operator: operatorOf(req) ?? 'anónimo' },
      });
      res.status(200).send(await detailHtml(business, req, { tab: 'invitaciones', deepLink: created.deepLink }));
    })
  );

  router.post(
    '/invitations/:id/revoke',
    route(async (req, res) => {
      const invitation = await deps.invitations.getById(String(req.params.id));
      if (!invitation) {
        notFound(res, 'Invitación no encontrada.');
        return;
      }
      await deps.invitations.revoke(invitation.businessId, invitation.id, null);
      await deps.audit.log({
        businessId: invitation.businessId,
        actorUserId: null,
        action: 'admin.invitation_revoked',
        entityType: 'invitation',
        entityId: invitation.id,
        metadata: { role: invitation.role, operator: operatorOf(req) ?? 'anónimo' },
      });
      res.redirect(`/admin/businesses/${invitation.businessId}?tab=invitaciones`);
    })
  );

  router.post(
    '/businesses/:id/status',
    route(async (req, res) => {
      const businessId = String(req.params.id);
      const business = await deps.businesses.getById(businessId);
      if (!business) {
        notFound(res, 'Negocio no encontrado.');
        return;
      }
      const parsed = statusSchema.safeParse(req.body);
      if (!parsed.success) {
        const message = parsed.error.issues[0]?.message ?? 'Datos inválidos.';
        res.status(400).send(await detailHtml(business, req, { tab: 'suscripcion', error: message }));
        return;
      }
      await deps.businesses.setStatus(businessId, parsed.data.status);
      await deps.audit.log({
        businessId,
        actorUserId: null,
        action: 'admin.status_changed',
        entityType: 'business',
        entityId: businessId,
        metadata: {
          from: business.status,
          to: parsed.data.status,
          reason: parsed.data.reason || undefined,
          operator: operatorOf(req) ?? 'anónimo',
        },
      });
      res.redirect(`/admin/businesses/${businessId}?tab=suscripcion`);
    })
  );

  // ------------------------------------------------------------ trials ---
  router.get(
    '/trials',
    route(async (req, res) => {
      const now = new Date();
      const all = await deps.businesses.listAll();
      const by = (bucket: 'pending' | 'active' | 'expiring' | 'expired') =>
        all.filter((b) => trialBucket(b, now) === bucket);
      res.status(200).send(
        trialsPage({
          expiring: by('expiring')
            .map((business) => ({ business, daysLeft: trialDaysLeft(business, now), endsAt: trialEndsAt(business) }))
            .sort((a, b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99)),
          expired: by('expired'),
          pending: by('pending'),
          active: by('active'),
          ...pageCtx(req),
        })
      );
    })
  );

  // ------------------------------------------------------------ pagos ---
  async function renderPayments(req: Request, res: Response, opts: { error?: string; flash?: string } = {}): Promise<void> {
    const filters = {
      businessId: String(req.query.businessId ?? ''),
      status: String(req.query.status ?? ''),
      method: String(req.query.method ?? ''),
      from: String(req.query.from ?? ''),
      to: String(req.query.to ?? ''),
    };
    const [all, recent] = await Promise.all([deps.businesses.listAll(), deps.payments.listRecent(200)]);
    const names = new Map(all.map((b) => [b.id, b.name] as const));
    const from = filters.from ? parseDateInput(filters.from) : null;
    const to = filters.to ? parseDateInput(filters.to) : null;
    let list = recent.map((payment) => ({
      payment,
      businessName: names.get(payment.businessId) ?? payment.businessId.slice(0, 8),
    }));
    if (filters.businessId) list = list.filter((r) => r.payment.businessId === filters.businessId);
    if (filters.status) list = list.filter((r) => r.payment.status === filters.status);
    if (filters.method) list = list.filter((r) => r.payment.method === filters.method);
    if (from) list = list.filter((r) => r.payment.paidAt >= from);
    if (to) {
      const end = new Date(to.getTime() + 86_400_000);
      list = list.filter((r) => r.payment.paidAt < end);
    }
    const totals = {
      confirmed: list.filter((r) => r.payment.status === 'CONFIRMED').reduce((a, r) => a + r.payment.amount, 0),
      pending: list.filter((r) => r.payment.status === 'PENDING').reduce((a, r) => a + r.payment.amount, 0),
      count: list.length,
    };
    res.status(opts.error ? 400 : 200).send(
      paymentsPage({
        payments: list.slice(0, 100),
        businesses: all,
        totals,
        filters,
        formKey: randomUUID(),
        error: opts.error,
        flash: opts.flash,
        ...pageCtx(req),
      })
    );
  }

  async function registerPayment(req: Request, businessId: string): Promise<{ payment: ManualPayment; duplicate: boolean } | { error: string }> {
    const ctx = pageCtx(req);
    const parsed = paymentSchema.safeParse({ ...req.body, businessId });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Datos inválidos.' };
    const business = await deps.businesses.getById(businessId);
    if (!business) return { error: 'Negocio no encontrado.' };
    const amount = parseAmount(parsed.data.amount);
    const paidAt = parseDateInput(parsed.data.paidAt);
    if (amount === null) return { error: 'Importe inválido (ej. 15000 o 15.000,50).' };
    if (!paidAt) return { error: 'Fecha de cobro inválida.' };
    const periodFrom = parsed.data.periodFrom ? parseDateInput(parsed.data.periodFrom) : null;
    const periodTo = parsed.data.periodTo ? parseDateInput(parsed.data.periodTo) : null;
    const idempotencyKey =
      typeof req.body?.idempotencyKey === 'string' && req.body.idempotencyKey.length >= 8
        ? String(req.body.idempotencyKey)
        : randomUUID();
    const concept = parsed.data.concept?.trim() || 'Suscripción';
    const notes = parsed.data.notes?.trim() || null;
    const result = await deps.payments.register({
      businessId,
      amount,
      currency: business.currency,
      paidAt,
      method: parsed.data.method,
      periodFrom,
      periodTo,
      concept,
      notes,
      operator: ctx.operator ?? 'anónimo',
      status: parsed.data.status,
      idempotencyKey,
    });
    await deps.audit.log({
      businessId,
      actorUserId: null,
      action: result.duplicate ? 'admin.payment_duplicate_ignored' : 'admin.payment_registered',
      entityType: 'payment',
      entityId: result.payment.id,
      metadata: {
        amount: result.payment.amount,
        currency: result.payment.currency,
        method: result.payment.method,
        status: result.payment.status,
        operator: ctx.operator ?? 'anónimo',
      },
    });
    return result;
  }

  router.get('/payments', route(async (req, res) => renderPayments(req, res)));

  router.post(
    '/payments',
    route(async (req, res) => {
      const businessId = String(req.body?.businessId ?? '');
      if (!businessId) {
        await renderPayments(req, res, { error: 'Elegí un negocio.' });
        return;
      }
      const result = await registerPayment(req, businessId);
      if ('error' in result) {
        await renderPayments(req, res, { error: result.error });
        return;
      }
      res.redirect(`/admin/businesses/${businessId}?tab=pagos`);
    })
  );

  router.post(
    '/businesses/:id/payments',
    route(async (req, res) => {
      const businessId = String(req.params.id);
      const business = await deps.businesses.getById(businessId);
      if (!business) {
        notFound(res, 'Negocio no encontrado.');
        return;
      }
      const result = await registerPayment(req, businessId);
      if ('error' in result) {
        res.status(400).send(await detailHtml(business, req, { tab: 'pagos', error: result.error }));
        return;
      }
      res.redirect(`/admin/businesses/${businessId}?tab=pagos`);
    })
  );

  router.post(
    '/payments/:id/void',
    route(async (req, res) => {
      const payment = await deps.payments.getById(String(req.params.id));
      if (!payment) {
        notFound(res, 'Pago no encontrado.');
        return;
      }
      const reason = String(req.body?.reason ?? '').trim().slice(0, 200) || 'corrección de registro';
      const businessId = String(req.body?.businessId ?? payment.businessId);
      if (payment.status === 'VOID') {
        res.redirect(`/admin/businesses/${payment.businessId}?tab=pagos`);
        return;
      }
      await deps.payments.void(payment.id, reason);
      await deps.audit.log({
        businessId: payment.businessId,
        actorUserId: null,
        action: 'admin.payment_voided',
        entityType: 'payment',
        entityId: payment.id,
        metadata: { reason, amount: payment.amount, operator: operatorOf(req) ?? 'anónimo' },
      });
      const back = (await deps.businesses.getById(businessId)) ? `/admin/businesses/${businessId}?tab=pagos` : '/admin/payments';
      res.redirect(back);
    })
  );

  // ---------------------------------------------------------- auditoría ---
  router.get(
    '/audit',
    route(async (_req, res) => {
      const [entries, names] = await Promise.all([deps.audit.listRecent(100), businessNameMap()]);
      res.status(200).send(
        auditPage({
          entries: entries.map((entry) => ({
            entry,
            businessName: names.get(entry.businessId) ?? entry.businessId.slice(0, 8),
          })),
          total: entries.length,
          ...pageCtx(_req),
        })
      );
    })
  );

  // ------------------------------------------------------------- config ---
  router.get(
    '/config',
    route((_req, res) => {
      res.status(200).send(
        configPage({
          trialDays: deps.trialDaysDefault,
          graceDays: deps.graceDaysDefault,
          templates: deps.templates,
          polling: process.env.TELEGRAM_POLLING ?? 'on',
          webhook: Boolean(process.env.TELEGRAM_WEBHOOK_URL),
          ...pageCtx(_req),
        })
      );
    })
  );

  // Ruta desconocida dentro de /admin (evita caer en el 404 genérico de Express).
  router.use((req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: `Ruta no encontrada: ${req.method} ${req.path}` });
  });

  return router;
}

/** Error amigable cuando un template no tiene bot configurado. */
export function botNotConfigured(templateId: string): AppError {
  return new AppError(
    `No hay bot configurado para '${templateId}'. Configurá TELEGRAM_BOT_TOKEN_${templateId.toUpperCase()}.`,
    'BOT_NOT_CONFIGURED',
    400
  );
}

export { evaluateAccess };
