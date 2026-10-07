import { describe, expect, it } from 'vitest';
import {
  ADMIN_SESSION_COOKIE,
  buildClearCookie,
  buildSessionCookie,
  passwordFingerprint,
  readCookie,
  signSession,
  verifySession,
} from '../src/app/admin/session.js';

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
