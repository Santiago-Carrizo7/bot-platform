import { escapeMarkdown } from '../../core/messaging/markdown.js';

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

/** Texto escapado para interpolar datos del usuario en mensajes Markdown. */
export function esc(text: string): string {
  return escapeMarkdown(text);
}
