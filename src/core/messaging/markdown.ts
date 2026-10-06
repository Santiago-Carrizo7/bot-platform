/** Escapa texto no confiable para interpolarlo en mensajes Markdown. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}
