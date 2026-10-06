import { describe, expect, it } from 'vitest';
import { evaluateAccess, shouldStartTrial } from '../src/core/tenant/business-status.js';
import { makeBusiness } from './fakes.js';

const NOW = new Date('2026-10-06T12:00:00Z');
const DAY = 86_400_000;

describe('evaluateAccess', () => {
  it('TRIAL sin iniciar: acceso total, trial pendiente', () => {
    const r = evaluateAccess(makeBusiness({ status: 'TRIAL', trialStartedAt: null }), NOW);
    expect(r).toMatchObject({ canRead: true, canWrite: true, effectiveStatus: 'TRIAL', trialDaysLeft: 10 });
    expect(shouldStartTrial(makeBusiness({ status: 'TRIAL', trialStartedAt: null }))).toBe(true);
  });

  it('TRIAL vigente: acceso total con días restantes', () => {
    const b = makeBusiness({ status: 'TRIAL', trialStartedAt: new Date(NOW.getTime() - 3 * DAY) });
    const r = evaluateAccess(b, NOW);
    expect(r.canWrite).toBe(true);
    expect(r.trialDaysLeft).toBe(7);
  });

  it('TRIAL vencido: solo lectura (efectivo READ_ONLY)', () => {
    const b = makeBusiness({ status: 'TRIAL', trialStartedAt: new Date(NOW.getTime() - 11 * DAY) });
    const r = evaluateAccess(b, NOW);
    expect(r).toMatchObject({ canRead: true, canWrite: false, effectiveStatus: 'READ_ONLY' });
  });

  it('ACTIVE vigente: total sin recordatorio', () => {
    const b = makeBusiness({ status: 'ACTIVE', subscriptionExpiresAt: new Date(NOW.getTime() + 30 * DAY) });
    const r = evaluateAccess(b, NOW);
    expect(r).toMatchObject({ canRead: true, canWrite: true, subscriptionReminder: false });
  });

  it('ACTIVE vencida en gracia: total + recordatorio (política permisiva)', () => {
    const b = makeBusiness({ status: 'ACTIVE', subscriptionExpiresAt: new Date(NOW.getTime() - 3 * DAY), graceDays: 7 });
    const r = evaluateAccess(b, NOW);
    expect(r).toMatchObject({ canRead: true, canWrite: true, subscriptionReminder: true });
  });

  it('ACTIVE vencida fuera de gracia: solo lectura + recordatorio', () => {
    const b = makeBusiness({ status: 'ACTIVE', subscriptionExpiresAt: new Date(NOW.getTime() - 30 * DAY), graceDays: 7 });
    const r = evaluateAccess(b, NOW);
    expect(r).toMatchObject({ canRead: true, canWrite: false, subscriptionReminder: true });
  });

  it('READ_ONLY: lee, no escribe', () => {
    const r = evaluateAccess(makeBusiness({ status: 'READ_ONLY' }), NOW);
    expect(r).toMatchObject({ canRead: true, canWrite: false });
  });

  it('SUSPENDED: bloquea todo', () => {
    const r = evaluateAccess(makeBusiness({ status: 'SUSPENDED' }), NOW);
    expect(r).toMatchObject({ canRead: false, canWrite: false });
  });
});
