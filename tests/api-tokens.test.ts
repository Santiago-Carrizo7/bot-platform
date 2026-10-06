import { describe, expect, it } from 'vitest';
import { signApiToken, verifyApiToken } from '../src/infrastructure/http/api-tokens.js';

const SECRET = 'secreto-de-prueba-largo-suficiente';

describe('API tokens (HMAC)', () => {
  it('firma y verifica un token válido con businessId firmado', () => {
    const token = signApiToken(SECRET, { userId: 'u1', businessId: 'b1' }, 3600);
    const payload = verifyApiToken(SECRET, token);
    expect(payload).toMatchObject({ userId: 'u1', businessId: 'b1' });
  });

  it('rechaza token manipulado (cambio de businessId invalida la firma)', () => {
    const token = signApiToken(SECRET, { userId: 'u1', businessId: 'b1' }, 3600);
    const [encoded, sig] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ userId: 'u1', businessId: 'b2', exp: 9999999999 })).toString('base64url');
    void encoded;
    expect(verifyApiToken(SECRET, `${forgedPayload}.${sig}`)).toBeNull();
  });

  it('rechaza token expirado', () => {
    const token = signApiToken(SECRET, { userId: 'u1', businessId: 'b1' }, -10);
    expect(verifyApiToken(SECRET, token)).toBeNull();
  });

  it('rechaza firma con otro secreto', () => {
    const token = signApiToken(SECRET, { userId: 'u1', businessId: 'b1' }, 3600);
    expect(verifyApiToken('otro-secreto-distinto-1234', token)).toBeNull();
  });

  it('rechaza formato inválido', () => {
    expect(verifyApiToken(SECRET, 'basura')).toBeNull();
    expect(verifyApiToken(SECRET, '')).toBeNull();
  });
});
