import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Sesión del admin web: cookie firmada HMAC (stateless, sin tabla de sesiones).
 * El payload lleva `pwdFp` (fingerprint corto de `ADMIN_PASSWORD`): rotar la
 * password en el env invalida TODAS las sesiones vigentes, que es la única forma
 * de "revocar" sin store server-side.
 */
export const ADMIN_SESSION_COOKIE = 'admin_session';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface AdminSessionPayload {
  /** Expiración en epoch ms. */
  exp: number;
  /** Fingerprint (8 hex de SHA-256) de la password vigente. */
  pwdFp: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function passwordFingerprint(password: string): string {
  return sha256Hex(password).slice(0, 8);
}

function hmac(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

function encodePayload(payload: AdminSessionPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodePayload(body: string): AdminSessionPayload | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.exp !== 'number' || typeof candidate.pwdFp !== 'string') return null;
    return { exp: candidate.exp, pwdFp: candidate.pwdFp };
  } catch {
    return null;
  }
}

/** Cookie value: `<payload base64url>.<hmac base64url>`. */
export function signSession(opts: { password: string; secret: string; now?: Date }): string {
  const now = (opts.now ?? new Date()).getTime();
  const body = encodePayload({ exp: now + SESSION_TTL_SECONDS * 1000, pwdFp: passwordFingerprint(opts.password) });
  return `${body}.${hmac(body, opts.secret)}`;
}

/** Devuelve el payload si la firma, la expiración y la password siguen vigentes. */
export function verifySession(
  value: string | undefined | null,
  opts: { password: string; secret: string; now?: Date }
): AdminSessionPayload | null {
  if (!value) return null;
  const separator = value.indexOf('.');
  if (separator <= 0 || separator === value.length - 1) return null;
  const body = value.slice(0, separator);
  const signature = value.slice(separator + 1);

  const expected = Buffer.from(hmac(body, opts.secret), 'utf8');
  const received = Buffer.from(signature, 'utf8');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;

  const payload = decodePayload(body);
  if (!payload) return null;
  if (payload.exp <= (opts.now ?? new Date()).getTime()) return null;
  if (payload.pwdFp !== passwordFingerprint(opts.password)) return null;
  return payload;
}

/** Lee un header Cookie simple (clave=valor; pares separados por `;`). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export interface CookieFlags {
  /** `Secure` solo cuando el proxy termina en https (`x-forwarded-proto`). */
  secure?: boolean;
}

function baseAttributes(flags: CookieFlags): string {
  return `Path=/admin; HttpOnly; SameSite=Strict${flags.secure ? '; Secure' : ''}`;
}

export function buildSessionCookie(value: string, flags: CookieFlags = {}): string {
  return `${ADMIN_SESSION_COOKIE}=${value}; ${baseAttributes(flags)}; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function buildClearCookie(flags: CookieFlags = {}): string {
  return `${ADMIN_SESSION_COOKIE}=; ${baseAttributes(flags)}; Max-Age=0`;
}
