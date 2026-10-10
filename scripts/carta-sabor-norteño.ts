import process from "node:process";
import { PrismaClient } from "@prisma/client";


const prisma = new PrismaClient();

// El ID del negocio "Rotiseria El amigo" que creaste en tu panel local
const BUSINESS_ID = "23886941-7853-43c4-836b-12877939c5d5";

async function main() {
  console.log("--- Cargando carta gastronómica ---");

  const productos = [
    // EMPANADAS (precio unitario y precio por docena con descuento)
    {
      name: "Empanada Carne Picante",
      category: "empanadas",
      priceUnit: 2400,
      priceDozen: 24000,
    },
    {
      name: "Empanada Carne Dulce",
      category: "empanadas",
      priceUnit: 2400,
      priceDozen: 24000,
    },
    {
      name: "Empanada Pollo",
      category: "empanadas",
      priceUnit: 2500,
      priceDozen: 25000,
    },
    {
      name: "Empanada Árabe",
      category: "empanadas",
      priceUnit: 2400,
      priceDozen: 24000,
    },
    {
      name: "Empanada Mediterránea",
      category: "empanadas",
      priceUnit: 2400,
      priceDozen: 24000,
    },
    {
      name: "Empanada Salteña",
      category: "empanadas",
      priceUnit: 2600,
      priceDozen: 26000,
    },
    {
      name: "Empanada Jamón y Queso",
      category: "empanadas",
      priceUnit: 2400,
      priceDozen: 24000,
    },

    // CANASTITAS
    {
      name: "Canastita Caprese",
      category: "canastitas",
      priceUnit: 2400,
      priceDozen: 24000,
    },
    {
      name: "Canastita Fugazzeta",
      category: "canastitas",
      priceUnit: 2400,
      priceDozen: 24000,
    },

    // PIZZAS
    {
      name: "Pizza Solo Muzza",
      category: "pizzas",
      priceUnit: 15000,
      priceDozen: null,
    },
    {
      name: "Pizza Napoli",
      category: "pizzas",
      priceUnit: 18000,
      priceDozen: null,
    },
    {
      name: "Pizza Tilcara",
      category: "pizzas",
      priceUnit: 18000,
      priceDozen: null,
    },
    {
      name: "Pizza Cachi",
      category: "pizzas",
      priceUnit: 17000,
      priceDozen: null,
    },
    {
      name: "Pizza Cafayate",
      category: "pizzas",
      priceUnit: 17000,
      priceDozen: null,
    },
    {
      name: "Pizza Cafayate Especial",
      category: "pizzas",
      priceUnit: 18000,
      priceDozen: null,
    },
    {
      name: "Pizza Purmamarca",
      category: "pizzas",
      priceUnit: 18000,
      priceDozen: null,
    },
    {
      name: "Pizza Pesto a las 3 hierbas",
      category: "pizzas",
      priceUnit: 16000,
      priceDozen: null,
    },
    {
      name: "Pizza Orán",
      category: "pizzas",
      priceUnit: 17000,
      priceDozen: null,
    },

    // CALZONES
    {
      name: "Calzón Pomodoro",
      category: "calzones",
      priceUnit: 18000,
      priceDozen: null,
    },
    {
      name: "Calzón Cipolla",
      category: "calzones",
      priceUnit: 17000,
      priceDozen: null,
    },

    // PASTAS CASERAS
    {
      name: "Canelones Tradicionales Verdura y Ricota (x6)",
      category: "pastas",
      priceUnit: 15000,
      priceDozen: null,
    },
    {
      name: "Canelones Sin Gluten Verdura y Ricota (x3)",
      category: "pastas",
      priceUnit: 9000,
      priceDozen: null,
    },
    {
      name: "Malfattis Sin Gluten Ricotta y Parmesano",
      category: "pastas",
      priceUnit: 16000,
      priceDozen: null,
    },
    {
      name: "Crepes de Champiñones (x4)",
      category: "pastas",
      priceUnit: 17000,
      priceDozen: null,
    },
    {
      name: "Crepes de Espárragos (x4)",
      category: "pastas",
      priceUnit: 17000,
      priceDozen: null,
    },
    {
      name: "Ñoquis de Papa (500g)",
      category: "pastas",
      priceUnit: 8000,
      priceDozen: null,
    },
    {
      name: "Lasaña Casera (900g)",
      category: "pastas",
      priceUnit: 16000,
      priceDozen: null,
    },
    {
      name: "Sorrentinos con Salsa Roja (x10)",
      category: "pastas",
      priceUnit: 15000,
      priceDozen: null,
    },
    {
      name: "Canelones con Salsa Roja (x3)",
      category: "pastas",
      priceUnit: 15000,
      priceDozen: null,
    },

    // SALSAS
    {
      name: "Salsa Roja 500cc",
      category: "salsas",
      priceUnit: 7000,
      priceDozen: null,
    },
    {
      name: "Salsa Bologñesa 500cc",
      category: "salsas",
      priceUnit: 10000,
      priceDozen: null,
    },

    // MEDIAS TARTAS
    {
      name: "Media Tarta Calabaza y Berenjena",
      category: "tartas",
      priceUnit: 14000,
      priceDozen: null,
    },
    {
      name: "Media Tarta Choclo y Zanahoria",
      category: "tartas",
      priceUnit: 14000,
      priceDozen: null,
    },
    {
      name: "Media Tarta Cebolla y Muzzarella",
      category: "tartas",
      priceUnit: 14000,
      priceDozen: null,
    },
    {
      name: "Media Tarta Verdura",
      category: "tartas",
      priceUnit: 14000,
      priceDozen: null,
    },
    {
      name: "Media Tarta Brócoli",
      category: "tartas",
      priceUnit: 14000,
      priceDozen: null,
    },

    // MEDALLONES SIN GLUTEN
    {
      name: "Medallón Quinoa Cebolla y Morrón",
      category: "medallones",
      priceUnit: 7000,
      priceDozen: null,
    },
    {
      name: "Medallón Quinoa Puerro",
      category: "medallones",
      priceUnit: 7000,
      priceDozen: null,
    },
  ];

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
  }

  // Carga de Promociones
  await prisma.rotiseriaPromo.upsert({
    where: {
      businessId_name: {
        businessId: BUSINESS_ID,
        name: "Pizza Promo",
      },
    },
    update: {
      price: 16000,
      description: "Pizza en promoción especial",
      isActive: true,
    },
    create: {
      businessId: BUSINESS_ID,
      name: "Pizza Promo",
      description: "Pizza en promoción especial",
      price: 16000,
      isActive: true,
    },
  });

  console.log(
    `Carta cargada exitosamente: ${productos.length} productos y 1 promo.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
