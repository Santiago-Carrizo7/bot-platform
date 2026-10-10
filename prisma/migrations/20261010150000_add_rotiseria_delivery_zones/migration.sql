-- AlterTable
ALTER TABLE "rotiseria_sales" ADD COLUMN "deliveryZoneName" TEXT,
ADD COLUMN "deliveryFee" DECIMAL(12,2);

-- CreateTable
CREATE TABLE "rotiseria_delivery_zones" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "barrios" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rotiseria_delivery_zones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rotiseria_delivery_zones_businessId_isActive_idx" ON "rotiseria_delivery_zones"("businessId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "rotiseria_delivery_zones_businessId_name_key" ON "rotiseria_delivery_zones"("businessId", "name");

-- AddForeignKey
ALTER TABLE "rotiseria_delivery_zones" ADD CONSTRAINT "rotiseria_delivery_zones_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
