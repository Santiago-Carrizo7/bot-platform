import type { MembershipRole } from '../tenant/entities.js';

/** OWNER puede todo; EMPLOYEE solo lo operativo. Sin matriz granular (aún). */
export function roleSatisfies(actor: MembershipRole, required: MembershipRole): boolean {
  if (required === 'EMPLOYEE') return true;
  return actor === 'OWNER';
}

/** Acciones reservadas a OWNER por defecto. */
export const OWNER_ONLY_HINT = 'Solo el dueño del negocio puede hacer esto.';
