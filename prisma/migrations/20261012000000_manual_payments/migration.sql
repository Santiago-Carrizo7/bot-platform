-- Pagos manuales del admin interno (sin pasarela). El historial nunca se borra: se anula.
CREATE TYPE "ManualPaymentStatus" AS ENUM ('CONFIRMED', 'PENDING', 'VOID');

CREATE TABLE "manual_payments" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ARS',
    "paidAt" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'EFECTIVO',
    "periodFrom" TIMESTAMP(3),
    "periodTo" TIMESTAMP(3),
    "concept" TEXT NOT NULL DEFAULT 'Suscripción',
    "notes" TEXT,
    "operator" TEXT,
    "status" "ManualPaymentStatus" NOT NULL DEFAULT 'CONFIRMED',
    "idempotencyKey" TEXT NOT NULL,
    "voidReason" TEXT,
    "voidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "manual_payments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "manual_payments_businessId_paidAt_idx" ON "manual_payments"("businessId", "paidAt");
CREATE INDEX "manual_payments_businessId_status_idx" ON "manual_payments"("businessId", "status");
CREATE UNIQUE INDEX "manual_payments_businessId_idempotencyKey_key" ON "manual_payments"("businessId", "idempotencyKey");

ALTER TABLE "manual_payments" ADD CONSTRAINT "manual_payments_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
