import type { Business, BusinessStatus } from './entities.js';

export interface AccessEvaluation {
  canRead: boolean;
  canWrite: boolean;
  /** Estado efectivo (un TRIAL vencido se comporta como READ_ONLY). */
  effectiveStatus: BusinessStatus;
  /** Días de trial restantes, solo si aplica. */
  trialDaysLeft: number | null;
  /** true si hay que mostrar recordatorio de pago/renovación. */
  subscriptionReminder: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Función pura: dado el negocio y "ahora", decide capacidades.
 * - TRIAL sin iniciar: acceso total, trial pendiente de inicio.
 * - TRIAL iniciado y vigente: acceso total + días restantes.
 * - TRIAL vencido: solo lectura (como READ_ONLY).
 * - ACTIVE vigente: total. ACTIVE vencida dentro de gracia: total + recordatorio.
 * - ACTIVE vencida fuera de gracia: solo lectura + recordatorio.
 * - READ_ONLY: solo lectura. SUSPENDED: nada.
 */
export function evaluateAccess(business: Business, now: Date = new Date()): AccessEvaluation {
  if (business.status === 'SUSPENDED') {
    return { canRead: false, canWrite: false, effectiveStatus: 'SUSPENDED', trialDaysLeft: null, subscriptionReminder: false };
  }

  if (business.status === 'READ_ONLY') {
    return { canRead: true, canWrite: false, effectiveStatus: 'READ_ONLY', trialDaysLeft: null, subscriptionReminder: false };
  }

  if (business.status === 'TRIAL') {
    if (!business.trialStartedAt) {
      return { canRead: true, canWrite: true, effectiveStatus: 'TRIAL', trialDaysLeft: business.trialDays, subscriptionReminder: false };
    }
    const elapsedDays = (now.getTime() - business.trialStartedAt.getTime()) / DAY_MS;
    if (elapsedDays <= business.trialDays) {
      return {
        canRead: true,
        canWrite: true,
        effectiveStatus: 'TRIAL',
        trialDaysLeft: Math.max(0, Math.ceil(business.trialDays - elapsedDays)),
        subscriptionReminder: false,
      };
    }
    return { canRead: true, canWrite: false, effectiveStatus: 'READ_ONLY', trialDaysLeft: 0, subscriptionReminder: true };
  }

  // ACTIVE
  if (business.subscriptionExpiresAt && now.getTime() > business.subscriptionExpiresAt.getTime()) {
    const daysOverdue = (now.getTime() - business.subscriptionExpiresAt.getTime()) / DAY_MS;
    if (daysOverdue <= business.graceDays) {
      return { canRead: true, canWrite: true, effectiveStatus: 'ACTIVE', trialDaysLeft: null, subscriptionReminder: true };
    }
    return { canRead: true, canWrite: false, effectiveStatus: 'READ_ONLY', trialDaysLeft: null, subscriptionReminder: true };
  }
  return { canRead: true, canWrite: true, effectiveStatus: 'ACTIVE', trialDaysLeft: null, subscriptionReminder: false };
}

/** El trial lo inicia la primera escritura de dominio, nunca antes. */
export function shouldStartTrial(business: Business): boolean {
  return business.status === 'TRIAL' && business.trialStartedAt === null;
}
