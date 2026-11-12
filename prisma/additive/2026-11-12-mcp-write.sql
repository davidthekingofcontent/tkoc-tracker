-- Conector MCP de TKOC Intelligence para Claude, capa de ACCIONES: tabla nueva (12 nov 2026).
--
-- ADDITIVE ONLY: one new table and its indexes. Nothing that already exists
-- is altered, renamed or dropped (tests/unit/mcp-additive-sql.test.ts fails
-- if this file ever contains such a statement).
--
-- Apply it AFTER prisma/additive/2026-11-12-mcp.sql (the read layer) and
-- BEFORE the code of the write layer ships, BY HAND, in one transaction:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 \
--     -f prisma/additive/2026-11-12-mcp-write.sql
--
-- Rollback: prisma/additive/2026-11-12-mcp-write.down.sql
--
-- Generated offline, with no database connection:
--   npx prisma migrate diff --from-schema <schema.prisma at HEAD 92f1a25> \
--     --to-schema prisma/schema.prisma --script
-- The statements below are that output, unedited.

-- CreateTable
CREATE TABLE "mcp_pending_actions" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "confirmation" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "argsJson" TEXT NOT NULL,
    "preview" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "executedAt" TIMESTAMP(3),
    "resultStatus" INTEGER,
    "tokenHash" TEXT,
    "stateHash" TEXT,

    CONSTRAINT "mcp_pending_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_pending_actions_tokenHash_key" ON "mcp_pending_actions"("tokenHash");

-- CreateIndex
CREATE INDEX "mcp_pending_actions_grantId_status_idx" ON "mcp_pending_actions"("grantId", "status");

-- CreateIndex
CREATE INDEX "mcp_pending_actions_status_expiresAt_idx" ON "mcp_pending_actions"("status", "expiresAt");

