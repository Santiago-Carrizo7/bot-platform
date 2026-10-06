/**
 * Gestión manual del webhook de Telegram (paso entre webhook y polling).
 * Uso:
 *   pnpm webhook -- --template kiosco            (ver estado actual)
 *   pnpm webhook -- --template kiosco --delete   (borrar webhook → vuelve a polling)
 */
import { Bot } from 'grammy';
import { configuredBots, loadConfig } from '../src/core/config/config.js';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const templateId = arg('template');
  if (!templateId) {
    console.log('Uso: pnpm webhook -- --template <id> [--delete]');
    process.exit(1);
  }
  const config = loadConfig();
  const binding = configuredBots(config).find((b) => b.templateId === templateId);
  if (!binding) {
    console.error(`No hay token configurado para el template '${templateId}'.`);
    process.exit(1);
  }
  const bot = new Bot(binding.token);
  if (process.argv.includes('--delete')) {
    await bot.api.deleteWebhook();
    console.log(`Webhook borrado para '${templateId}'. Telegram vuelve a aceptar polling.`);
    return;
  }
  const info = await bot.api.getWebhookInfo();
  if (!info.url) {
    console.log(`'${templateId}' sin webhook (modo polling).`);
  } else {
    console.log(`'${templateId}' → ${info.url} (pendientes: ${info.pending_update_count})`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
