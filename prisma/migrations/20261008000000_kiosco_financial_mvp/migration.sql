-- DropForeignKey
ALTER TABLE "sale_items" DROP CONSTRAINT "sale_items_productId_fkey";

-- DropForeignKey
ALTER TABLE "sale_items" DROP CONSTRAINT "sale_items_saleId_fkey";

-- DropForeignKey
ALTER TABLE "purchases" DROP CONSTRAINT "purchases_productId_fkey";

-- DropForeignKey
ALTER TABLE "purchases" DROP CONSTRAINT "purchases_businessId_fkey";

-- DropForeignKey
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_productId_fkey";

-- DropForeignKey
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_businessId_fkey";

-- DropForeignKey
ALTER TABLE "sales" DROP CONSTRAINT "sales_businessId_fkey";

-- DropForeignKey
ALTER TABLE "products" DROP CONSTRAINT "products_businessId_fkey";

-- DropTable
DROP TABLE "sale_items";

-- DropTable
DROP TABLE "sales";

-- DropTable
DROP TABLE "purchases";

-- DropTable
DROP TABLE "stock_movements";

-- DropTable
DROP TABLE "products";
