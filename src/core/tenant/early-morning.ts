export interface EarlyMorningContext {
  isEarlyMorning: boolean;
  timeStr: string;
  yesterdayLabel: string;
  todayLabel: string;
  yesterdayDate: Date;
  todayDate: Date;
}

/**
 * Evalúa si la hora local en la zona horaria del negocio está en la ventana de madrugada (00:00 a 04:59 hs).
 * Devuelve etiquetas formateadas para "Ayer" y "Hoy" (ej. "Miércoles 7", "Jueves 8") y las fechas efectivas.
 */
export function getEarlyMorningContext(
  now: Date,
  timezone = 'America/Argentina/Buenos_Aires'
): EarlyMorningContext {
  const safeTz = isValidTimezone(timezone) ? timezone : 'America/Argentina/Buenos_Aires';

  const formatter = new Intl.DateTimeFormat('es-AR', {
    timeZone: safeTz,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });

  const parts = formatter.formatToParts(now);
  const partMap: Record<string, string> = {};
  for (const p of parts) {
    partMap[p.type] = p.value;
  }

  const hour = parseInt(partMap.hour ?? '0', 10);
  const minute = (partMap.minute ?? '0').padStart(2, '0');
  const isEarlyMorning = hour >= 0 && hour < 5;
  const timeStr = `${String(hour).padStart(2, '0')}:${minute} hs`;

  const year = parseInt(partMap.year ?? String(now.getFullYear()), 10);
  const month = parseInt(partMap.month ?? String(now.getMonth() + 1), 10) - 1;
  const day = parseInt(partMap.day ?? String(now.getDate()), 10);

  const todayRef = new Date(Date.UTC(year, month, day, 12, 0, 0));
  const yesterdayRef = new Date(Date.UTC(year, month, day - 1, 12, 0, 0));

  const formatDayLabel = (d: Date): string => {
    const dayFormatter = new Intl.DateTimeFormat('es-AR', {
      timeZone: 'UTC',
      weekday: 'long',
      day: 'numeric',
    });
    const text = dayFormatter.format(d).replace(',', '');
    return text.charAt(0).toUpperCase() + text.slice(1);
  };

  return {
    isEarlyMorning,
    timeStr,
    todayLabel: formatDayLabel(todayRef),
    yesterdayLabel: formatDayLabel(yesterdayRef),
    yesterdayDate: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    todayDate: now,
  };
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
