-- CreateTable
CREATE TABLE "AdminAdjustment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountLamports" BIGINT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminAdjustment_userId_idx" ON "AdminAdjustment"("userId");

-- AddForeignKey
ALTER TABLE "AdminAdjustment" ADD CONSTRAINT "AdminAdjustment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
