-- CreateTable
CREATE TABLE "integration_transfers" (
    "id" TEXT NOT NULL,
    "protocol_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL,
    "next_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "response_code" INTEGER,
    "payload_hash" CHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_transfers_status_next_attempt_at_idx" ON "integration_transfers"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "integration_transfers_protocol_id_idx" ON "integration_transfers"("protocol_id");

-- AddForeignKey
ALTER TABLE "integration_transfers" ADD CONSTRAINT "integration_transfers_protocol_id_fkey" FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE;
