import { PrismaClient } from '@prisma/client';
import process from 'node:process';

const prisma = new PrismaClient();

const productos = [
  // --- BURGERS DOBLES / VEGGIE ---
  { name: "Hamburguesa Brown", category: "hamburguesas", priceUnit: 8500 },
  { name: "Hamburguesa Brown Veggie", category: "hamburguesas", priceUnit: 7100 },
  { name: "Hamburguesa Pirlo", category: "hamburguesas", priceUnit: 8500 },
  { name: "Hamburguesa Pirlo Veggie", category: "hamburguesas", priceUnit: 7100 },
  { name: "Hamburguesa Titan", category: "hamburguesas", priceUnit: 8500 },
  { name: "Hamburguesa Titan Veggie", category: "hamburguesas", priceUnit: 7100 },
  { name: "Hamburguesa Mediterranea", category: "hamburguesas", priceUnit: 12500 },
  { name: "Hamburguesa Mediterranea Veggie", category: "hamburguesas", priceUnit: 7100 },
  { name: "Hamburguesa Provolone Brown", category: "hamburguesas", priceUnit: 1700 },
  { name: "Hamburguesa Provolone Brown Veggie", category: "hamburguesas", priceUnit: 7200 },
  { name: "Hamburguesa Baston", category: "hamburguesas", priceUnit: 8700 },
  { name: "Hamburguesa Baston Veggie", category: "hamburguesas", priceUnit: 7200 },
  { name: "Hamburguesa Cheeseburger", category: "hamburguesas", priceUnit: 8300 },
  { name: "Hamburguesa Cheeseburger Veggie", category: "hamburguesas", priceUnit: 7000 },
  { name: "Hamburguesa Aros", category: "hamburguesas", priceUnit: 8700 },
  { name: "Hamburguesa Aros Veggie", category: "hamburguesas", priceUnit: 7200 },
  { name: "Hamburguesa Atomica", category: "hamburguesas", priceUnit: 8700 },
  { name: "Hamburguesa Atomica Veggie", category: "hamburguesas", priceUnit: 7200 },
  { name: "Hamburguesa Crispy", category: "hamburguesas", priceUnit: 8700 },
  { name: "Hamburguesa Crispy Veggie", category: "hamburguesas", priceUnit: 7200 },
  { name: "Hamburguesa Champi", category: "hamburguesas", priceUnit: 8700 },
  { name: "Hamburguesa Champi Veggie", category: "hamburguesas", priceUnit: 7200 },
  { name: "Hamburguesa Alioli", category: "hamburguesas", priceUnit: 8700 },
  { name: "Hamburguesa Alioli Veggie", category: "hamburguesas", priceUnit: 7200 },
  { name: "Hamburguesa Especial", category: "hamburguesas", priceUnit: 8500 },
  { name: "Hamburguesa Especial Veggie", category: "hamburguesas", priceUnit: 7100 },
  { name: "Hamburguesa Frida", category: "hamburguesas", priceUnit: 8700 },
  { name: "Hamburguesa Frida Veggie", category: "hamburguesas", priceUnit: 7200 },
  { name: "Hamburguesa Lebron", category: "hamburguesas", priceUnit: 8700 },
  { name: "Hamburguesa Lebron Veggie", category: "hamburguesas", priceUnit: 7200 },

  // --- EXTRAS ---
  { name: "Medallón extra de carne", category: "extras", priceUnit: 500 }
];

async function main() {
  const businessId = process.argv[2];

  if (!businessId) {
    console.error("❌ Error: Debes proporcionar el businessId como argumento. Ejemplo:");
    console.error("   pnpm exec tsx scripts/cargar-brown.ts <UUID_DEL_NEGOCIO>");
    process.exit(1);
  }

  console.log(`\n🚀 Iniciando carga para el negocio: ${businessId}...\n`);

  for (const prod of productos) {
    await prisma.rotiseriaProduct.upsert({
      where: {
        businessId_name: {
          businessId,
          name: prod.name
        }
      },
      update: {
        priceUnit: prod.priceUnit,
        priceDozen: null,
        priceHalfDozen: null,
        category: prod.category,
        isActive: true
      },
      create: {
        businessId,
        name: prod.name,
        category: prod.category,
        priceUnit: prod.priceUnit,
        priceDozen: null,
        priceHalfDozen: null,
        isActive: true
      }
    });

    console.log(`  ✓ ${prod.name} -> $${prod.priceUnit}`);
  }

  console.log(`\n✅ Carga completada con éxito (${productos.length} productos procesados).\n`);
}

main()
  .catch((e) => {
    console.error("❌ Error durante la ejecución:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });