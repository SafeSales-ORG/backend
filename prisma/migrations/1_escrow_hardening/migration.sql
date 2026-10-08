-- Escrow hardening: payouts ledger, buyer secret token, paid-amount
-- tracking, delivery fee on orders; drop plaintext Nostr private keys.

-- CreateEnum
CREATE TYPE "PayoutKind" AS ENUM ('SELLER_RELEASE', 'BUYER_REFUND');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('pending', 'succeeded', 'failed', 'manual');

-- AlterTable: drop unused, plaintext-stored Nostr private keys.
ALTER TABLE "User" DROP COLUMN "nostrNsec";

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "buyerToken" TEXT,
ADD COLUMN     "deliveryFeeNGN" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "paidAmountNGN" INTEGER,
ADD COLUMN     "paidAt" TIMESTAMP(3);

-- Backfill: existing orders get a fresh random buyer secret. (Their old
-- links keep working for viewing via orderToken; buyer actions need the
-- new token.)
UPDATE "Order"
SET "buyerToken" = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
WHERE "buyerToken" IS NULL;

ALTER TABLE "Order" ALTER COLUMN "buyerToken" SET NOT NULL;

-- AlterTable: dispute evidence from both parties + the seller's reply.
ALTER TABLE "Dispute" ADD COLUMN     "evidence" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "sellerResponse" TEXT;

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" "PayoutKind" NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'pending',
    "amountNGN" INTEGER NOT NULL,
    "feeNGN" INTEGER NOT NULL DEFAULT 0,
    "reference" TEXT NOT NULL,
    "providerRef" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Order_buyerToken_key" ON "Order"("buyerToken");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_reference_key" ON "Payout"("reference");

-- CreateIndex
CREATE INDEX "Payout_status_idx" ON "Payout"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_orderId_kind_key" ON "Payout"("orderId", "kind");

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
