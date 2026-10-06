import express, { type Express, type NextFunction, type Request, type Response, type Router } from 'express';

export type { Router };
import cors from 'cors';
import { ZodError } from 'zod';
import { AppError } from '../../core/errors/errors.js';
import { logger } from '../../core/logging/logger.js';
import type { MembershipService } from '../../core/identity/membership.service.js';
import type { UserService } from '../../core/identity/user.service.js';
import { verifyApiToken } from './api-tokens.js';

export interface RequestContext {
  userId: string;
  businessId: string;
}

export interface AuthenticatedRequest extends Request {
  auth?: RequestContext;
}

export interface CreateAppDeps {
  memberships: MembershipService;
  users: UserService;
  apiSecret: string;
  /** Routers aportados por templates (ya scropeados por negocio vía req.auth). */
  templateRouters?: Router[];
  corsOrigins?: string[];
}

export function createAuthMiddleware(memberships: MembershipService, apiSecret: string) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const header = req.headers.authorization;
      if (!header || !header.startsWith('Bearer ')) {
        res.status(401).json({ error: 'UNAUTHORIZED', message: 'Se requiere Authorization: Bearer <token>' });
        return;
      }
      const payload = verifyApiToken(apiSecret, header.slice(7).trim());
      if (!payload) {
        res.status(401).json({ error: 'INVALID_TOKEN', message: 'Token inválido o expirado' });
        return;
      }
      // El businessId viene del payload FIRMADO, nunca del cliente.
      const membership = await memberships.requireMembership(payload.userId, payload.businessId);
      req.auth = { userId: membership.userId, businessId: membership.businessId };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function createExpressApp(deps: CreateAppDeps): Express {
  const app = express();
  app.use(cors(deps.corsOrigins ? { origin: deps.corsOrigins } : undefined));
  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug(`[HTTP] ${req.method} ${req.path}`);
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
  });

  const auth = createAuthMiddleware(deps.memberships, deps.apiSecret);
  const api = express.Router();
  api.use(auth);
  api.get('/me', async (req: AuthenticatedRequest, res: Response) => {
    const user = await deps.users.getById(req.auth!.userId);
    if (!user) {
      res.status(404).json({ error: 'USER_NOT_FOUND', message: 'Usuario no encontrado' });
      return;
    }
    const memberships = await deps.memberships.membershipsOfUser(user.id);
    const current = memberships.find((m) => m.businessId === req.auth!.businessId);
    res.json({
      data: {
        id: user.id,
        telegramId: user.telegramId,
        businessId: req.auth!.businessId,
        role: current?.role ?? null,
      },
    });
  });
  for (const router of deps.templateRouters ?? []) {
    api.use(router);
  }
  app.use('/api', api);

  // Manejador centralizado de errores (debe ir último).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'VALIDATION_ERROR', details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
      return;
    }
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.code, message: err.message });
      return;
    }
    logger.error('[HTTP] Error no controlado', err);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Ocurrió un error inesperado' });
  });

  return app;
}
