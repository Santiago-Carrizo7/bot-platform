/**
 * Smoke test de punta a punta (solo HTTP + DB, sin Telegram).
 * Uso: pnpm exec tsx scripts/smoke.ts
 * Crea un negocio temporal, opera la API de gastos con token HMAC y lo borra.
 */
import { loadConfig } from '../src/core/config/config.js';
import { logger } from '../src/core/logging/logger.js';
import { prisma } from '../src/infrastructure/persistence/prisma.js';
import { signApiToken } from '../src/infrastructure/http/api-tokens.js';
import { buildCoreServices, buildHttpApp, buildAdminRouter, createBotUsernameResolver } from '../src/app/container.js';
import { createGastosTemplate } from '../src/templates/gastos/index.js';
import type { AddressInfo } from 'node:net';

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
  console.log(`  ok: ${msg}`);
};

async function main() {
  const config = loadConfig();
  const core = buildCoreServices(config);
  const gastos = createGastosTemplate({ db: prisma, memberships: core.memberships, apiSecret: config.API_SECRET });

  // Negocio + usuario + membership temporales.
  const business = await core.businesses.create({ name: 'Smoke Test', templateId: 'gastos' });
  await gastos.seedBusiness(business.id);
  const user = await core.users.getOrCreateByTelegramId('999999-smoke');
  await core.memberships.ensureMembership(business.id, user.id, 'OWNER');
  const token = signApiToken(config.API_SECRET, { userId: user.id, businessId: business.id }, 600);

  // El admin se monta igual que en el bootstrap real (404 sin ADMIN_PASSWORD).
  const adminRouter = buildAdminRouter(core, config, {
    templates: [{ id: gastos.template.id, label: gastos.template.label }],
    seedBusiness: async (templateId, businessId) => {
      if (templateId !== gastos.template.id) throw new Error(`Template sin seed en el smoke: ${templateId}`);
      await gastos.seedBusiness(businessId);
    },
    resolveBotUsername: createBotUsernameResolver(config),
  });
  const app = buildHttpApp(core, [{ id: gastos.template.id, router: gastos.router }], [], adminRouter);
  const server = await new Promise<ReturnType<typeof app.listen>>((res) => {
    const s = app.listen(0, () => res(s));
  });
  const port = (server.address() as AddressInfo).port;
  const base = `http://localhost:${port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  console.log('Smoke test contra', base);

  try {
    let r = await fetch(`${base}/health`);
    assert(r.ok, 'GET /health');

    // Admin web: sin ADMIN_PASSWORD la ruta ni existe (404); con ella, sin sesión
    // manda al login (302).
    r = await fetch(`${base}/admin/`, { redirect: 'manual' });
    assert(
      r.status === (config.ADMIN_PASSWORD ? 302 : 404),
      `GET /admin/ → ${config.ADMIN_PASSWORD ? '302 a login (ADMIN_PASSWORD seteada)' : '404 (sin ADMIN_PASSWORD)'}`
    );

    r = await fetch(`${base}/api/me`, { headers });
    assert(r.ok, 'GET /api/me con token HMAC');
    const me = (await r.json()) as { data: { businessId: string; role: string } };
    assert(me.data.businessId === business.id && me.data.role === 'OWNER', '/api/me devuelve negocio y rol');

    r = await fetch(`${base}/api/v1/gastos/expenses`, {
      method: 'POST', headers, body: JSON.stringify({ amount: 5000, description: 'Saeta', category: 'transporte' }),
    });
    assert(r.status === 201, 'POST /api/v1/gastos/expenses crea gasto');
    const created = (await r.json()) as { data: { id: string; amount: number } };
    assert(created.data.amount === 5000, 'monto serializado como número');

    r = await fetch(`${base}/api/v1/gastos/expenses?limit=5`, { headers });
    assert(r.ok && ((await r.json()) as { data: unknown[] }).data.length === 1, 'GET /api/v1/gastos/expenses lista 1');

    r = await fetch(`${base}/api/v1/gastos/summary`, { headers });
    const summary = (await r.json()) as { data: { total: number; count: number } };
    assert(summary.data.total === 5000 && summary.data.count === 1, 'GET /api/v1/gastos/summary totaliza');

    r = await fetch(`${base}/api/v1/gastos/budgets`, {
      method: 'POST', headers, body: JSON.stringify({ category: 'transporte', amount: 20000 }),
    });
    assert(r.status === 201, 'POST /api/v1/gastos/budgets fija presupuesto');

    r = await fetch(`${base}/api/v1/gastos/budgets`, { headers });
    const budgets = (await r.json()) as { data: Array<{ spentAmount: number }> };
    assert(budgets.data.length === 1 && budgets.data[0].spentAmount === 5000, 'GET /api/v1/gastos/budgets con progreso');

    r = await fetch(`${base}/api/v1/gastos/expenses/${created.data.id}`, { method: 'DELETE', headers });
    assert(r.status === 204, 'DELETE /api/v1/gastos/expenses/:id elimina');

    // Token manipulado (otro negocio) debe fallar.
    const forged = signApiToken(config.API_SECRET, { userId: user.id, businessId: 'negocio-ajeno' }, 600);
    r = await fetch(`${base}/api/v1/gastos/expenses`, { headers: { Authorization: `Bearer ${forged}` } });
    assert(r.status === 403, 'token con businessId ajeno es rechazado (403)');

    console.log('SMOKE OK');
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
    await prisma.business.delete({ where: { id: business.id } });
    await prisma.user.deleteMany({ where: { telegramId: '999999-smoke' } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  logger.error('Smoke test falló', error);
  process.exit(1);
});
