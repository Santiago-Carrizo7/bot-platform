-- CreateTable
CREATE TABLE "rotiseria_products" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceUnit" DECIMAL(12,2) NOT NULL,
    "priceDozen" DECIMAL(12,2),
    "category" TEXT NOT NULL DEFAULT 'empanadas',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rotiseria_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rotiseria_promos" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rotiseria_promos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rotiseria_sales" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "shiftDate" DATE NOT NULL,
    "isCancelled" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancelReason" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rotiseria_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rotiseria_sale_items" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "productId" TEXT,
    "promoId" TEXT,
    "name" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "rotiseria_sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rotiseria_products_businessId_isActive_idx" ON "rotiseria_products"("businessId", "isActive");

-- CreateIndex
CREATE INDEX "rotiseria_products_businessId_category_idx" ON "rotiseria_products"("businessId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "rotiseria_products_businessId_name_key" ON "rotiseria_products"("businessId", "name");

-- CreateIndex
CREATE INDEX "rotiseria_promos_businessId_isActive_idx" ON "rotiseria_promos"("businessId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "rotiseria_promos_businessId_name_key" ON "rotiseria_promos"("businessId", "name");

-- CreateIndex
CREATE INDEX "rotiseria_sales_businessId_shiftDate_idx" ON "rotiseria_sales"("businessId", "shiftDate");

-- CreateIndex
CREATE INDEX "rotiseria_sales_businessId_createdAt_idx" ON "rotiseria_sales"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "rotiseria_sales_businessId_isCancelled_idx" ON "rotiseria_sales"("businessId", "isCancelled");

-- CreateIndex
CREATE INDEX "rotiseria_sale_items_saleId_idx" ON "rotiseria_sale_items"("saleId");

-- CreateIndex
CREATE INDEX "rotiseria_sale_items_productId_idx" ON "rotiseria_sale_items"("productId");

-- CreateIndex
CREATE INDEX "rotiseria_sale_items_promoId_idx" ON "rotiseria_sale_items"("promoId");

-- AddForeignKey
ALTER TABLE "rotiseria_products" ADD CONSTRAINT "rotiseria_products_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rotiseria_promos" ADD CONSTRAINT "rotiseria_promos_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rotiseria_sales" ADD CONSTRAINT "rotiseria_sales_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rotiseria_sale_items" ADD CONSTRAINT "rotiseria_sale_items_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "rotiseria_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rotiseria_sale_items" ADD CONSTRAINT "rotiseria_sale_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "rotiseria_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rotiseria_sale_items" ADD CONSTRAINT "rotiseria_sale_items_promoId_fkey" FOREIGN KEY ("promoId") REFERENCES "rotiseria_promos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
