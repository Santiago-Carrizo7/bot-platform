import { createHash, timingSafeEqual } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../../core/errors/errors.js';
import { logger } from '../../core/logging/logger.js';
import type { AuditService } from '../../core/audit/audit.service.js';
import type { InvitationService } from '../../core/identity/invitation.service.js';
import type { MembershipService } from '../../core/identity/membership.service.js';
import type { UserService } from '../../core/identity/user.service.js';
import type { BusinessService } from '../../core/tenant/business.service.js';
import { loginPage } from './pages.js';
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

  router.get(
    '/',
    route((_req, res) => {
      res.status(200).send('admin: sesión válida');
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
