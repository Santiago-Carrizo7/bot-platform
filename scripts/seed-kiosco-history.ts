/**
 * Script para sembrar movimientos históricos en un negocio de Kiosco
 * para probar estadísticas diarias, semanales y mensuales.
 * 
 * Uso:
 *   pnpm tsx scripts/seed-kiosco-history.ts
 *   pnpm tsx scripts/seed-kiosco-history.ts --clean  (borra los movimientos de prueba)
 */
import { prisma } from '../src/infrastructure/persistence/prisma.js';
import { logger } from '../src/core/logging/logger.js';

async function main() {
  const isClean = process.argv.includes('--clean');

  // Buscar el negocio de kiosco
  const business = await prisma.business.findFirst({
    where: { templateId: 'kiosco' },
    include: { memberships: true },
  });

  if (!business) {
    console.error('❌ No se encontró ningún negocio con templateId="kiosco" en la base de datos.');
    process.exit(1);
  }

  const userId = business.memberships[0]?.userId ?? 'system-seed';
  console.log(`🏪 Negocio encontrado: "${business.name}" (${business.id})`);

  if (isClean) {
    const deleted = await prisma.moneyMovement.deleteMany({
      where: {
        businessId: business.id,
        concept: { startsWith: '[TEST]' },
      },
    });
    console.log(`🧹 Se eliminaron ${deleted.count} movimientos de prueba con prefijo [TEST].`);
    await prisma.$disconnect();
    return;
  }

  // Zona horaria de Argentina: UTC-3
  // Ej: 15:00 ART = 18:00 UTC, 21:15 ART = 00:15 UTC (día siguiente)
  const createArtDate = (year: number, month: number, day: number, hour: number, minute: number): Date => {
    // Mes es 1-based (1 = enero, 9 = sept, 10 = oct)
    const utcHour = hour + 3;
    return new Date(Date.UTC(year, month - 1, day, utcHour, minute, 0));
  };

  const movementsToSeed = [
    // --- SEPTIEMBRE (Mes anterior) ---
    // 25 de septiembre: Ventas variadas, sin gastos
    { kind: 'IN', amount: 8500, concept: '[TEST] Ventas mañana', category: 'Ventas', date: createArtDate(2026, 9, 25, 11, 30) },
    { kind: 'IN', amount: 14200, concept: '[TEST] Ventas tarde', category: 'Ventas', date: createArtDate(2026, 9, 25, 18, 45) },
    
    // 28 de septiembre: Ventas y gasto de reposición mercadería
    { kind: 'IN', amount: 19000, concept: '[TEST] Ventas del día', category: 'Ventas', date: createArtDate(2026, 9, 28, 16, 0) },
    { kind: 'OUT', amount: 25000, concept: '[TEST] Compra mayorista golosinas', category: 'Mercadería', date: createArtDate(2026, 9, 28, 10, 15) },

    // 30 de septiembre (Cierre de mes anterior): Pago de servicio
    { kind: 'IN', amount: 22400, concept: '[TEST] Ventas fin de mes', category: 'Ventas', date: createArtDate(2026, 9, 30, 20, 0) },
    { kind: 'OUT', amount: 12000, concept: '[TEST] Factura de luz', category: 'Servicios', date: createArtDate(2026, 9, 30, 12, 0) },

    // --- OCTUBRE (Semana 1: 1 al 4 de octubre) ---
    // 2 de octubre: Solo ventas
    { kind: 'IN', amount: 16500, concept: '[TEST] Ventas viernes', category: 'Ventas', date: createArtDate(2026, 10, 2, 19, 0) },
    { kind: 'IN', amount: 9800, concept: '[TEST] Bebidas y puchos', category: 'Ventas', date: createArtDate(2026, 10, 2, 21, 30) },

    // --- OCTUBRE (Esta semana: 5 al 11 de octubre) ---
    // Martes 6 de octubre: Ventas chicas y medianas
    { kind: 'IN', amount: 4500, concept: '[TEST] Ventas golosinas', category: 'Ventas', date: createArtDate(2026, 10, 6, 10, 30) },
    { kind: 'IN', amount: 8200, concept: '[TEST] Gaseosas y snacks', category: 'Ventas', date: createArtDate(2026, 10, 6, 17, 15) },

    // Jueves 8 de octubre: Venta fuerte y gasto de flete/proveedor
    { kind: 'IN', amount: 32000, concept: '[TEST] Ventas ráfaga tarde', category: 'Ventas', date: createArtDate(2026, 10, 8, 19, 30) },
    { kind: 'OUT', amount: 15000, concept: '[TEST] Reposición panadería y flete', category: 'Transporte', date: createArtDate(2026, 10, 8, 9, 0) },

    // Viernes 9 de octubre: Solo ventas
    { kind: 'IN', amount: 21500, concept: '[TEST] Ventas viernes noche', category: 'Ventas', date: createArtDate(2026, 10, 9, 20, 45) },

    // Sábado 10 de octubre (AYER):
    // Ventas a la tarde + Venta de las 21:15 hs de la noche (clave para probar la zona horaria de Argentina)
    { kind: 'IN', amount: 11000, concept: '[TEST] Ventas sábado siesta', category: 'Ventas', date: createArtDate(2026, 10, 10, 15, 0) },
    { kind: 'IN', amount: 15000, concept: '[TEST] Venta nocturna (21:15 hs)', category: 'Ventas', date: createArtDate(2026, 10, 10, 21, 15) },
    { kind: 'OUT', amount: 4000, concept: '[TEST] Artículos de limpieza', category: 'Otros', date: createArtDate(2026, 10, 10, 11, 0) },
  ];

  console.log(`📦 Insertando ${movementsToSeed.length} movimientos de prueba...`);

  for (const m of movementsToSeed) {
    await prisma.moneyMovement.create({
      data: {
        businessId: business.id,
        userId,
        kind: m.kind,
        amount: m.amount,
        concept: m.concept,
        category: m.category,
        date: m.date,
      },
    });
  }

  console.log('✅ ¡Movimientos de prueba sembrados con éxito!');
  console.log('\n📊 Resumen de lo que cargamos:');
  console.log('  • Septiembre (Mes anterior): 3 ventas ($ 45.100) y 2 gastos ($ 37.000). Balance: +$ 8.100');
  console.log('  • Octubre Semana 1 (1-4 Oct): 2 ventas ($ 26.300), 0 gastos.');
  console.log('  • Octubre Semana 2 (5-11 Oct): 5 ventas ($ 92.200) y 2 gastos ($ 19.000).');
  console.log('    - Incluye la venta de ayer a las 21:15 hs ($ 15.000).');
  console.log('  • Hoy (11 Oct): $ 0 (limpio, para que pruebes registrar algo nuevo).');
  console.log('\n💡 Tip: Para borrar estos datos de prueba cuando quieras, ejecutá:');
  console.log('  pnpm tsx scripts/seed-kiosco-history.ts --clean');

  await prisma.$disconnect();
}

main().catch((err) => {
  logger.error('Error al sembrar movimientos', err);
  process.exit(1);
});
