import { escapeMarkdown } from '../../core/messaging/markdown.js';
import { getShiftDate } from './domain/shift.js';

export function formatCurrency(amount: number | string): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  const formatted = new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(num);
  return `$ ${formatted}`;
}

export function formatQty(qty: number | string): string {
  const n = typeof qty === 'string' ? parseFloat(qty) : qty;
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

export function formatDateTime(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day}/${month} ${hours}:${minutes}`;
}

export function formatDateOnly(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

/**
 * Formato estricto requerido por el spec: día de la semana y fecha real (ej. "Jueves 08/10/2026").
 * PROHIBIDO usar etiquetas ambiguas ("ayer", "hoy" a secas).
 */
export function formatRealDateWithDay(date: Date): string {
  const dayName = WEEKDAYS[date.getUTCDay()];
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${dayName} ${day}/${month}/${year}`;
}

export function getCategoryIcon(category: string): string {
  const cat = category.toLowerCase().trim();
  if (cat.includes('empanada')) return '🥟';
  if (cat.includes('pizza')) return '🍕';
  if (cat.includes('sandwich') || cat.includes('sándwich')) return '🥪';
  if (cat.includes('promo') || cat.includes('combo')) return '🎁';
  if (cat.includes('bebida')) return '🥤';
  if (cat.includes('postre')) return '🍨';
  return '🍽️';
}

export function esc(text: string): string {
  return escapeMarkdown(text);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function formatTimeOnly(date: Date, timezone = 'America/Argentina/Buenos_Aires'): string {
  return new Intl.DateTimeFormat('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(date);
}

export function formatSaleNumber(saleId: string, count?: number): string {
  if (count !== undefined && count > 0) return `${count}`;
  const m = saleId.match(/(\d+)/);
  if (m) return `${m[1]}`;
  return `${saleId.slice(0, 6).toUpperCase()}`;
}

export interface FormatSaleSummaryParams {
  items: Array<{ nombre: string; cantidad: number }>;
  nota?: string;
  fecha?: string;
  breakdown?: string[];
  total?: number;
  isModifying?: boolean;
  now?: Date;
  timezone?: string;
  noReconocidos?: string[];
}

/**
 * Formatea el resumen de venta para confirmación de manera limpia,
 * profesional y legible, con viñetas, totales destacados y fecha asignada.
 */
export function formatSaleSummary(params: FormatSaleSummaryParams): string {
  const parts: string[] = [];
  if (params.isModifying) {
    parts.push('🔄 *Pedido actualizado:*', '');
  }
  parts.push('📋 *Detalle del pedido:*');

  if (params.breakdown && params.breakdown.length > 0) {
    parts.push(...params.breakdown);
  } else {
    for (const it of params.items) {
      parts.push(`• ${formatQty(it.cantidad)}x *${esc(it.nombre)}*`);
    }
  }

  if (params.noReconocidos && params.noReconocidos.length > 0) {
    parts.push('');
    for (const term of params.noReconocidos) {
      parts.push(`⚠️ No reconocí *${esc(term)}* (no fue sumado al pedido)`);
    }
  }

  if (params.total !== undefined && params.total > 0) {
    parts.push('', `💰 *Total:* *${formatCurrency(params.total)}*`);
  }

  if (params.nota) {
    parts.push(`📝 *Nota:* ${esc(params.nota)}`);
  }

  const targetDate = params.fecha
    ? new Date(params.fecha.includes('T') ? params.fecha : `${params.fecha}T12:00:00Z`)
    : getShiftDate(params.now ?? new Date(), params.timezone ?? 'America/Argentina/Buenos_Aires');

  parts.push(`📅 *Fecha asignada:* ${formatRealDateWithDay(targetDate)}`);
  parts.push('', params.isModifying ? '¿Confirmamos esta venta?' : '¿Confirmar venta?');
  return parts.join('\n');
}

export interface FormatSaleReceiptParams {
  saleId: string;
  count?: number;
  total: number;
  shiftDate: Date;
  createdAt: Date;
  breakdown: string[];
  timezone?: string;
  note?: string;
}

export function formatSaleReceipt(params: FormatSaleReceiptParams): string {
  const num = formatSaleNumber(params.saleId, params.count);
  const tz = params.timezone ?? 'America/Argentina/Buenos_Aires';
  const lines: string[] = [
    `✅ Venta #${num} registrada con éxito`,
    '',
    '📋 Comanda:',
    ...params.breakdown,
    '',
    `💰 Total cobrado: *${formatCurrency(params.total)}*`,
    `📅 Fecha del turno: *${formatRealDateWithDay(params.shiftDate)}*`,
    `🕒 Registrado: ${formatTimeOnly(params.createdAt, tz)} hs`,
  ];
  if (params.note) {
    lines.push(`📝 Nota: ${esc(params.note)}`);
  }
  return lines.join('\n');
}
