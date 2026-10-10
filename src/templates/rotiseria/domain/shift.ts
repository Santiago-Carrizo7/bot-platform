/**
 * Lógica de jornada gastronómica (turno operativo).
 * En gastronomía, el servicio nocturno se extiende hasta la madrugada.
 * Las ventas realizadas entre las 00:00 y las 04:59 AM computan
 * a la fecha operativa del día anterior ("Cierre de anoche").
 */

export interface ShiftComponents {
  year: number;
  month: number; // 0-indexed (0 = Enero)
  day: number;
  hour: number;
  minute: number;
}

export function getLocalShiftComponents(
  date: Date = new Date(),
  timezone = 'America/Argentina/Buenos_Aires'
): ShiftComponents {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const getPart = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';

  return {
    year: parseInt(getPart('year'), 10),
    month: parseInt(getPart('month'), 10) - 1,
    day: parseInt(getPart('day'), 10),
    hour: parseInt(getPart('hour'), 10),
    minute: parseInt(getPart('minute'), 10),
  };
}

/**
 * Calcula la fecha operativa (shiftDate) normalizada a UTC medianoche (00:00:00.000Z),
 * ideal para columnas @db.Date de Postgres / Prisma.
 */
export function getShiftDate(
  date: Date = new Date(),
  timezone = 'America/Argentina/Buenos_Aires'
): Date {
  const comp = getLocalShiftComponents(date, timezone);
  const target = new Date(Date.UTC(comp.year, comp.month, comp.day, 0, 0, 0, 0));

  // Ventas entre 00:00 y 04:59 AM computan a la jornada anterior.
  if (comp.hour < 5) {
    target.setUTCDate(target.getUTCDate() - 1);
  }

  return target;
}

/**
 * Retorna el rango de Date [start, end] que abarca un shiftDate en UTC.
 */
export function getShiftDateRange(shiftDate: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(shiftDate.getUTCFullYear(), shiftDate.getUTCMonth(), shiftDate.getUTCDate(), 0, 0, 0, 0));
  const end = new Date(Date.UTC(shiftDate.getUTCFullYear(), shiftDate.getUTCMonth(), shiftDate.getUTCDate(), 23, 59, 59, 999));
  return { start, end };
}

import { formatRealDateWithDay } from '../format.js';

/**
 * Etiqueta legible para la jornada, siempre con fecha real y día de la semana.
 * PROHIBIDO usar "ayer" o "hoy" a secas.
 */
export function formatShiftLabel(
  shiftDate: Date
): string {
  return `Turno del ${formatRealDateWithDay(shiftDate)}`;
}
