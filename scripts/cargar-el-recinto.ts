import process from "node:process";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Permite pasar el ID por argumento CLI: pnpm exec tsx scripts/cargar-el-recinto.ts --business <ID>
function getBusinessId(): string {
  const argIdx = process.argv.indexOf("--business");
  if (argIdx >= 0 && process.argv[argIdx + 1]) {
    return process.argv[argIdx + 1];
  }
  return "1234576"; // ID por defecto
}

const BUSINESS_ID = getBusinessId();

async function main() {
  console.log(`\n🚀 Cargando datos para negocio ID: ${BUSINESS_ID} (El Recinto)...`);

  // ==========================================
  // 1. CARTA GASTRONÓMICA (EMPANADAS)
  // ==========================================
  const productos = [
    // Docena común ($20.000 docena / $1.800 unidad)
    { name: "Empanada de Carne", category: "empanadas", priceUnit: 1800, priceDozen: 20000 },
    { name: "Empanada de Carne Picante", category: "empanadas", priceUnit: 1800, priceDozen: 20000 },
    { name: "Empanada de Pollo", category: "empanadas", priceUnit: 1800, priceDozen: 20000 },
    { name: "Empanada de Queso", category: "empanadas", priceUnit: 1800, priceDozen: 20000 },
    { name: "Empanada de Jamón y Queso", category: "empanadas", priceUnit: 1800, priceDozen: 20000 },
    { name: "Empanada de Quinua", category: "empanadas", priceUnit: 1800, priceDozen: 20000 },
    { name: "Empanada de Verdura", category: "empanadas", priceUnit: 1800, priceDozen: 20000 },
    { name: "Empanada de Atún", category: "empanadas", priceUnit: 1800, priceDozen: 20000 },
    { name: "Empanada de Choclo", category: "empanadas", priceUnit: 1800, priceDozen: 20000 },
    { name: "Empanada de Roquefort", category: "empanadas", priceUnit: 1800, priceDozen: 20000 },
    { name: "Empanada Caprese", category: "empanadas", priceUnit: 1800, priceDozen: 20000 },

    // Docena especial ($22.000 docena / $2.000 unidad)
    { name: "Empanada Árabe", category: "empanadas", priceUnit: 2000, priceDozen: 22000 },
  ];

  console.log("\n📦 Cargando catálogo de empanadas...");
  for (const prod of productos) {
    await prisma.rotiseriaProduct.upsert({
      where: {
        businessId_name: {
          businessId: BUSINESS_ID,
          name: prod.name,
        },
      },
      update: {
        priceUnit: prod.priceUnit,
        priceDozen: prod.priceDozen,
        category: prod.category,
        isActive: true,
      },
      create: {
        businessId: BUSINESS_ID,
        name: prod.name,
        category: prod.category,
        priceUnit: prod.priceUnit,
        priceDozen: prod.priceDozen,
        isActive: true,
      },
    });
    console.log(`  ✓ ${prod.name} (U: $${prod.priceUnit} | D: $${prod.priceDozen})`);
  }

  // ==========================================
  // 2. ZONAS DE ENVÍO Y BARRIOS (DELIVERY)
  // ==========================================
  const zonasEnvio = [
    {
      name: "Cuyaya / Moreno",
      price: 3000,
      barrios: ["cuyaya", "moreno"],
    },
    {
      name: "Centro",
      price: 3500,
      barrios: ["centro", "microcentro", "macrocentro"],
    },
    {
      name: "Santa Rosa / Coronel Arias",
      price: 3500,
      barrios: ["santa rosa", "coronel arias", "arias"],
    },
    {
      name: "San Pedrito / San Martín / Belgrano / Chijra / Ciudad de Nieva",
      price: 4000,
      barrios: [
        "san pedrito",
        "san martin",
        "belgrano",
        "chijra",
        "ciudad nieva",
        "ciudad de nieva",
        "nieva",
      ],
    },
    {
      name: "Los Perales",
      price: 4500,
      barrios: ["perales", "los perales"],
    },
    {
      name: "Alto Comedero (Sargento Cabral)",
      price: 6500,
      barrios: ["sargento cabral", "alto comedero sargento cabral"],
    },
    {
      name: "Alto Comedero (30 Hectáreas)",
      price: 7000,
      barrios: ["30 hectareas", "30 hectáreas", "alto comedero 30 hectareas"],
    },
  ];

  console.log("\n🛵 Cargando zonas de delivery y barrios...");
  for (const zona of zonasEnvio) {
    await prisma.rotiseriaDeliveryZone.upsert({
      where: {
        businessId_name: {
          businessId: BUSINESS_ID,
          name: zona.name,
        },
      },
      update: {
        price: zona.price,
        barrios: zona.barrios,
        isActive: true,
      },
      create: {
        businessId: BUSINESS_ID,
        name: zona.name,
        price: zona.price,
        barrios: zona.barrios,
        isActive: true,
      },
    });
    console.log(`  ✓ ${zona.name} — $${zona.price} [${zona.barrios.join(", ")}]`);
  }

  console.log(`\n✅ ¡Listo! Se cargaron ${productos.length} sabores y ${zonasEnvio.length} zonas de envío.\n`);
}

main()
  .catch((e) => {
    console.error("❌ Error ejecutando la carga:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });