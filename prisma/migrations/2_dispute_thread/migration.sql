-- Case thread: buyers (no account), sellers, the mediator and system notes
-- all post to DisputeMessage.

CREATE TYPE "DisputeParty" AS ENUM ('buyer', 'seller', 'mediator', 'system');

ALTER TABLE "DisputeMessage" ALTER COLUMN "authorId" DROP NOT NULL;
ALTER TABLE "DisputeMessage" ADD COLUMN "authorRole" "DisputeParty" NOT NULL DEFAULT 'seller';
ALTER TABLE "DisputeMessage" ADD COLUMN "attachments" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "DisputeMessage" ADD COLUMN "requestFrom" TEXT;

-- Backfill who wrote existing messages.
UPDATE "DisputeMessage" m SET "authorRole" = 'mediator'
FROM "User" u
WHERE u."id" = m."authorId" AND u."role" IN ('MEDIATOR', 'ADMIN');

UPDATE "DisputeMessage" m SET "authorRole" = 'buyer'
FROM "Dispute" d, "Order" o
WHERE d."id" = m."disputeId" AND o."id" = d."orderId" AND o."buyerId" = m."authorId";

ALTER TABLE "DisputeMessage" ALTER COLUMN "authorRole" DROP DEFAULT;

ALTER TABLE "DisputeMessage" DROP CONSTRAINT "DisputeMessage_authorId_fkey";
ALTER TABLE "DisputeMessage" ADD CONSTRAINT "DisputeMessage_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
