import process from "node:process";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function getBusinessId(): string {
  const argIdx = process.argv.indexOf("--business");
  if (argIdx >= 0 && process.argv[argIdx + 1]) {
    return process.argv[argIdx + 1];
  }
  console.error("❌ Error: Debes pasar el ID del negocio con --business <UUID>");
  process.exit(1);
}

const BUSINESS_ID = getBusinessId();

async function main() {
  console.log(`\n🧹 Purgando ventas, tickets, catálogo y zonas para negocio: ${BUSINESS_ID}...`);

  // 1. Borrar ítems de venta (hijos)
  await prisma.rotiseriaSaleItem.deleteMany({
    where: { sale: { businessId: BUSINESS_ID } },
  });

  // 2. Borrar las ventas completas (tickets y caja)
  await prisma.rotiseriaSale.deleteMany({
    where: { businessId: BUSINESS_ID },
  });

  // 3. Borrar catálogo anterior (productos y promos)
  await prisma.rotiseriaProduct.deleteMany({
    where: { businessId: BUSINESS_ID },
  });

  await prisma.rotiseriaPromo.deleteMany({
    where: { businessId: BUSINESS_ID },
  });

  // 4. Borrar zonas de delivery anteriores
  await prisma.rotiseriaDeliveryZone.deleteMany({
    where: { businessId: BUSINESS_ID },
  });

  console.log("✅ Limpieza completa. Cargando carta y zonas oficiales de El Recinto...\n");

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

  console.log("📦 Insertando productos...");
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

  console.log("\n🛵 Insertando zonas de delivery...");
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

  console.log(`\n✅ Proceso terminado: 0 ventas previas, ${productos.length} sabores activos y ${zonasEnvio.length} zonas cargadas.\n`);
}

main()
  .catch((e) => {
    console.error("❌ Error ejecutando la carga:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });