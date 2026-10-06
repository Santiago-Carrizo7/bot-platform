import { escapeMarkdown } from '../../core/messaging/markdown.js';
import { SYSTEM_CATEGORIES } from './types.js';

const CATEGORY_ICONS: Record<string, string> = Object.fromEntries(
  SYSTEM_CATEGORIES.map((c) => [c.name, c.icon])
);

export function getCategoryIcon(categoryName: string, customIcon?: string | null): string {
  if (customIcon) return customIcon;
  return CATEGORY_ICONS[categoryName.toLowerCase().trim()] ?? '🏷️';
}

export function formatCurrency(amount: number | string, currency = 'ARS'): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  const formatted = new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(num);
  if (currency === 'USD') return `US$ ${formatted}`;
  return `$ ${formatted}`;
}

export function formatDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

export function renderProgressBar(percentage: number): string {
  const totalBlocks = 10;
  const clamped = Math.max(0, Math.min(100, percentage));
  const filled = Math.round((clamped / 100) * totalBlocks);
  return '█'.repeat(filled) + '░'.repeat(totalBlocks - filled);
}

/** Texto escapado para interpolar datos del usuario en mensajes Markdown. */
export function esc(text: string): string {
  return escapeMarkdown(text);
}
