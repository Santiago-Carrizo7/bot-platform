import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ApiTokenPayload {
  userId: string;
  businessId: string;
  /** expiración en epoch seconds */
  exp: number;
}

function base64urlEncode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function base64urlDecode<T>(part: string): T {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
}

/** Token firmado HMAC-SHA256: base64url(payload).base64url(sig). */
export function signApiToken(
  secret: string,
  input: { userId: string; businessId: string },
  expiresInSeconds: number,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): string {
  const payload: ApiTokenPayload = {
    userId: input.userId,
    businessId: input.businessId,
    exp: nowSeconds + expiresInSeconds,
  };
  const encoded = base64urlEncode(payload);
  const sig = createHmac('sha256', secret).update(encoded).digest();
  return `${encoded}.${sig.toString('base64url')}`;
}

/** Verifica firma y expiración. Devuelve null si es inválido. */
export function verifyApiToken(
  secret: string,
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): ApiTokenPayload | null {
  const [encoded, sigPart] = token.split('.');
  if (!encoded || !sigPart) return null;
  let payload: ApiTokenPayload;
  try {
    payload = base64urlDecode<ApiTokenPayload>(encoded);
  } catch {
    return null;
  }
  if (!payload.userId || !payload.businessId || typeof payload.exp !== 'number') return null;
  if (payload.exp <= nowSeconds) return null;
  const expected = createHmac('sha256', secret).update(encoded).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(sigPart, 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return payload;
}
