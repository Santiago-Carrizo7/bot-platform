import process from "node:process";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Permite pasar el UUID por CLI: pnpm exec tsx scripts/cargar-el-cinco.ts --business <ID>
function getBusinessId(): string {
  const argIdx = process.argv.indexOf("--business");
  if (argIdx >= 0 && process.argv[argIdx + 1]) {
    return process.argv[argIdx + 1];
  }
  // Si no se pasa flag, podés colocar el ID por defecto acá:
  return "COLOCA_AQUI_EL_BUSINESS_ID";
}

const BUSINESS_ID = getBusinessId();

async function main() {
  if (BUSINESS_ID === "COLOCA_AQUI_EL_BUSINESS_ID") {
    console.error("❌ Debes pasar un businessId válido con: --business <UUID>");
    process.exit(1);
  }

  console.log(`\n🚀 Cargando carta gastronómica de 'El Cinco' (Negocio ID: ${BUSINESS_ID})...\n`);

  // ==========================================
  // 1. PRODUCTOS (EMPANADAS, PIZZAS, BEBIDAS, EXTRAS)
  // ==========================================
  const productos: Array<{
    name: string;
    category: string;
    priceUnit: number;
    priceDozen?: number | null;
    priceHalfDozen?: number | null;
  }> = [
    // --- EMPANADAS ($12.000 Docena / $6.000 Media / $1.000 Unidad) ---
    {
      name: "Empanada Salteña",
      category: "empanadas",
      priceUnit: 1000,
      priceDozen: 12000,
      priceHalfDozen: 6000,
    },
    {
      name: "Empanada de Pollo",
      category: "empanadas",
      priceUnit: 1000,
      priceDozen: 12000,
      priceHalfDozen: 6000,
    },
    {
      name: "Empanada de Queso",
      category: "empanadas",
      priceUnit: 1000,
      priceDozen: 12000,
      priceHalfDozen: 6000,
    },
    {
      name: "Empanada Árabe",
      category: "empanadas",
      priceUnit: 1000,
      priceDozen: 12000,
      priceHalfDozen: 6000,
    },
    {
      name: "Empanada de Jamón y Queso",
      category: "empanadas",
      priceUnit: 1000,
      priceDozen: 12000,
      priceHalfDozen: 6000,
    },

    // --- PIZZAS (Enteras y Medias como ítems individuales) ---
    { name: "Pizza Mozzarella", category: "pizzas", priceUnit: 10000, priceDozen: null },
    { name: "Media Pizza Mozzarella", category: "pizzas", priceUnit: 5500, priceDozen: null },

    { name: "Pizza Especial", category: "pizzas", priceUnit: 11000, priceDozen: null },
    { name: "Media Pizza Especial", category: "pizzas", priceUnit: 6000, priceDozen: null },

    { name: "Pizza Napolitana", category: "pizzas", priceUnit: 11000, priceDozen: null },
    { name: "Media Pizza Napolitana", category: "pizzas", priceUnit: 6000, priceDozen: null },

    { name: "Pizza Especial Napo", category: "pizzas", priceUnit: 12000, priceDozen: null },
    { name: "Media Pizza Especial Napo", category: "pizzas", priceUnit: 6500, priceDozen: null },

    { name: "Pizza Fugazza", category: "pizzas", priceUnit: 11000, priceDozen: null },
    { name: "Media Pizza Fugazza", category: "pizzas", priceUnit: 6000, priceDozen: null },

    { name: "Pizza Especial con Huevo", category: "pizzas", priceUnit: 12000, priceDozen: null },
    { name: "Media Pizza Especial con Huevo", category: "pizzas", priceUnit: 6500, priceDozen: null },

    // --- BEBIDAS (Formato estándar para matching de voz/texto) ---
    { name: "Coca-Cola 1.5L", category: "bebidas", priceUnit: 4000, priceDozen: null },
    { name: "Sprite 1.5L", category: "bebidas", priceUnit: 4000, priceDozen: null },
    { name: "Coca-Cola 600ml", category: "bebidas", priceUnit: 2500, priceDozen: null },
    { name: "Cerveza Salta 1L", category: "bebidas", priceUnit: 5500, priceDozen: null },

    // --- EXTRAS ---
    { name: "Queso Extra 100g", category: "extras", priceUnit: 2000, priceDozen: null },
  ];

  console.log("📦 1. Cargando productos en la base de datos...");
  for (const prod of productos) {
    // Si aún no migraste priceHalfDozen en Prisma, se omite limpiamente
    const dataPayload: Record<string, unknown> = {
      priceUnit: prod.priceUnit,
      priceDozen: prod.priceDozen ?? null,
      category: prod.category,
      isActive: true,
    };

    if ("priceHalfDozen" in prod && prod.priceHalfDozen !== undefined) {
      dataPayload.priceHalfDozen = prod.priceHalfDozen;
    }

    await prisma.rotiseriaProduct.upsert({
      where: {
        businessId_name: {
          businessId: BUSINESS_ID,
          name: prod.name,
        },
      },
      update: dataPayload,
      create: {
        businessId: BUSINESS_ID,
        name: prod.name,
        ...dataPayload,
      } as any,
    });

    console.log(`  ✓ [${prod.category}] ${prod.name} -> $${prod.priceUnit}`);
  }

  // ==========================================
  // 2. PROMOCIONES
  // ==========================================
  const promos = [
    {
      name: "Promo Amigo",
      price: 16000,
      description: "1 Docena de Empanadas + 1 Cerveza Salta 1L",
    },
    {
      name: "Promo Dúo",
      price: 14500,
      description: "1 Pizza Especial + 1 Gaseosa 1.5L",
    },
    {
      name: "Promo Familiar",
      price: 25500,
      description: "1 Pizza Muzzarella + 1 Docena de Empanadas + 1 Gaseosa 1.5L",
    },
    {
      name: "Promo Individual",
      price: 7500,
      description: "1/2 Pizza Muzzarella + 1 Coca-Cola 600ml",
    },
    {
      name: "Promo Amigo 2",
      price: 23000,
      description: "2 Docenas de Empanadas",
    },
    {
      name: "Promo Individual 2",
      price: 8000,
      description: "1/2 Docena de Empanadas a elección + 1 Coca-Cola 600ml",
    },
  ];

  console.log("\n🏷️  2. Cargando promociones...");
  for (const promo of promos) {
    await prisma.rotiseriaPromo.upsert({
      where: {
        businessId_name: {
          businessId: BUSINESS_ID,
          name: promo.name,
        },
      },
      update: {
        price: promo.price,
        description: promo.description,
        isActive: true,
      },
      create: {
        businessId: BUSINESS_ID,
        name: promo.name,
        description: promo.description,
        price: promo.price,
        isActive: true,
      },
    });

    console.log(`  ✓ ${promo.name} -> $${promo.price} (${promo.description})`);
  }

  console.log(`\n✅ Carga finalizada con éxito: ${productos.length} productos y ${promos.length} promociones registradas.`);
}

main()
  .catch((e) => {
    console.error("❌ Error en el seeder:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });