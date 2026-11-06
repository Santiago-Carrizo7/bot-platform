/**
 * Desactiva (isActive: false) los productos de tartas con nombres informales/abreviados
 * creados como parche. No borra: las ventas históricas conservan su referencia.
 *
 * Uso (dry-run por defecto):
 *   pnpm exec tsx scripts/limpiar-tartas-duplicadas.ts <businessId>
 *   pnpm exec tsx scripts/limpiar-tartas-duplicadas.ts <businessId> --apply
 */
import { PrismaClient } from '@prisma/client';
import process from 'node:process';
import { cleanString } from '../src/templates/rotiseria/domain/product.service.js';

const INFORMAL_NAMES = [
  'Tarta Cala Bere',
  'Tarta cebo muzza',
  'Tarta Choco Zana',
  'Tarta Cala Berenjena',
  'Tarta Choco Zanahoria',
  'Tarta Brocoli',
  'Tarta verdura',
];

async function main(): Promise<void> {
  const businessId = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!businessId || businessId.startsWith('--')) {
    console.error('Uso: tsx scripts/limpiar-tartas-duplicadas.ts <businessId> [--apply]');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const informal = new Set(INFORMAL_NAMES.map(cleanString));
    const actives = await prisma.rotiseriaProduct.findMany({ where: { businessId, isActive: true } });
    const targets = actives.filter((p) => informal.has(cleanString(p.name)));

    if (targets.length === 0) {
      console.log('No hay productos informales activos para desactivar.');
      return;
    }
    for (const p of targets) {
      console.log(`${apply ? 'Desactivando' : '[dry-run] Desactivaría'}: "${p.name}" (${p.id})`);
    }
    if (apply) {
      const res = await prisma.rotiseriaProduct.updateMany({
        where: { businessId, id: { in: targets.map((p) => p.id) } },
        data: { isActive: false },
      });
      console.log(`Listo: ${res.count} producto(s) desactivado(s).`);
    } else {
      console.log('Dry-run: agregá --apply para aplicar los cambios.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
