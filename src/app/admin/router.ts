import { createHash, timingSafeEqual } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../core/errors/errors.js';
import { logger } from '../../core/logging/logger.js';
import type { AuditService } from '../../core/audit/audit.service.js';
import type { InvitationService } from '../../core/identity/invitation.service.js';
import type { MembershipService } from '../../core/identity/membership.service.js';
import type { UserService } from '../../core/identity/user.service.js';
import type { BusinessService } from '../../core/tenant/business.service.js';
import type { Business } from '../../core/tenant/entities.js';
import {
  businessDetailPage,
  businessListPage,
  invitationStatus,
  isTimezone,
  loginPage,
  type InvitationView,
  type MemberView,
} from './pages.js';
import {
  ADMIN_SESSION_COOKIE,
  buildClearCookie,
  buildSessionCookie,
  readCookie,
  signSession,
  verifySession,
} from './session.js';

/** 5 fallos de login cada 10 min por IP → 429 (en memoria, un solo proceso). */
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 10 * 60_000;

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
  // Comparación sobre SHA-256: misma longitud siempre, sin leak por timing.
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

export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false }));

  const sessionOpts = { password: deps.password, secret: deps.apiSecret };
  const sessionOf = (req: Request) => verifySession(readCookie(req.headers.cookie, ADMIN_SESSION_COOKIE), sessionOpts);
  const secureFlag = (req: Request) => req.headers['x-forwarded-proto'] === 'https';
  const clientIp = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'desconocida';

  // Fallos de login por IP (ventana deslizante simple).
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

  // Chequeo de origen: solo POST del mismo host.
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
      const window = loginFailuresOf(ip);

      if (window.count >= LOGIN_MAX_FAILURES) {
        logger.warn('[admin] Login bloqueado por rate limit', { ip });
        res.status(429).send(loginPage({ error: 'Demasiados intentos. Probá de nuevo en 10 minutos.' }));
        return;
      }
      if (!passwordMatches(submitted, deps.password)) {
        window.count += 1;
        // Nunca loguear la password: solo si falló y cuántos intentos lleva.
        logger.warn('[admin] Login fallido', { ip, failures: window.count });
        res.status(401).send(loginPage({ error: 'Password incorrecta.' }));
        return;
      }
      window.count = 0;
      logger.info('[admin] Login correcto', { ip });
      res.setHeader('Set-Cookie', buildSessionCookie(signSession(sessionOpts), { secure: secureFlag(req) }));
      res.redirect('/admin/');
    })
  );

  router.post(
    '/logout',
    route((req, res) => {
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
  });

  /** HTML del detalle: datos + miembros (telegramId + rol) + invitaciones. */
  async function detailHtml(business: Business, opts: { deepLink?: string; error?: string } = {}): Promise<string> {
    const [memberships, invitations] = await Promise.all([
      deps.memberships.listByBusiness(business.id),
      deps.invitations.listByBusiness(business.id),
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
    return businessDetailPage({ business, members, invitations: views, ...opts });
  }

  async function loadDetail(businessId: string, opts: { deepLink?: string; error?: string } = {}): Promise<string | null> {
    const business = await deps.businesses.getById(businessId);
    return business ? detailHtml(business, opts) : null;
  }

  router.get(
    '/',
    route(async (_req, res) => {
      const businesses = await deps.businesses.listAll();
      res.status(200).send(businessListPage(businesses, { templates: deps.templates }));
    })
  );

  router.post(
    '/businesses',
    route(async (req, res) => {
      const parsed = createBusinessSchema.safeParse(req.body);
      if (!parsed.success) {
        const message = parsed.error.issues[0]?.message ?? 'Datos inválidos.';
        res.status(400).send(businessListPage(await deps.businesses.listAll(), { templates: deps.templates, error: message }));
        return;
      }
      const { name, templateId, timezone, currency } = parsed.data;
      const business = await deps.businesses.create({ name, templateId, timezone, currency });
      try {
        await deps.seedBusiness(templateId, business.id);
      } catch (error) {
        logger.error('[admin] Falló el seed del template', { templateId, businessId: business.id, error });
        res.status(500).send(
          businessListPage(await deps.businesses.listAll(), {
            templates: deps.templates,
            error: `El negocio se creó pero falló el seed del template '${templateId}': ${
              error instanceof Error ? error.message : String(error)
            }`,
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
        metadata: { templateId, name },
      });
      res.redirect(`/admin/businesses/${business.id}`);
    })
  );

  router.get(
    '/businesses/:id',
    route(async (req, res) => {
      const html = await loadDetail(String(req.params.id));
      if (!html) {
        notFound(res, 'Negocio no encontrado.');
        return;
      }
      res.status(200).send(html);
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
        res.status(400).send(await detailHtml(business, { error: message }));
        return;
      }
      let botUsername: string;
      try {
        botUsername = await deps.resolveBotUsername(business.templateId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('[admin] No se pudo resolver el bot para la invitación', { templateId: business.templateId, error: message });
        res.status(400).send(await detailHtml(business, { error: message }));
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
        metadata: { role: parsed.data.role, days: parsed.data.days },
      });
      // El deep link viaja SOLO en este HTML: la DB guarda el hash.
      res.status(200).send(await detailHtml(business, { deepLink: created.deepLink }));
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
        metadata: { role: invitation.role },
      });
      res.redirect(`/admin/businesses/${invitation.businessId}`);
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
        res.status(400).send(await detailHtml(business, { error: message }));
        return;
      }
      await deps.businesses.setStatus(businessId, parsed.data.status);
      await deps.audit.log({
        businessId,
        actorUserId: null,
        action: 'admin.status_changed',
        entityType: 'business',
        entityId: businessId,
        metadata: { from: business.status, to: parsed.data.status },
      });
      res.redirect(`/admin/businesses/${businessId}`);
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
