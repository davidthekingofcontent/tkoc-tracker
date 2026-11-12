-- Conector MCP de TKOC Intelligence para Claude: tablas nuevas (12 nov 2026).
--
-- ADDITIVE ONLY: five new tables and their indexes. Nothing that already
-- exists is altered, renamed or dropped (tests/unit/mcp-additive-sql.test.ts
-- fails if this file ever contains such a statement).
--
-- The deploy does not push the schema. Apply this file BY HAND, before the
-- code that uses these tables ships, in one transaction:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 \
--     -f prisma/additive/2026-11-12-mcp.sql
--
-- Rollback: prisma/additive/2026-11-12-mcp.down.sql
--
-- Generated offline, with no database connection:
--   npx prisma migrate diff --from-schema <schema.prisma at HEAD> \
--     --to-schema prisma/schema.prisma --script
-- The statements below are that output, unedited.

-- CreateTable
CREATE TABLE "mcp_clients" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "createdFromIp" TEXT,

    CONSTRAINT "mcp_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_grants" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "mcp_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_auth_codes" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "grantId" TEXT,

    CONSTRAINT "mcp_auth_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_tokens" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "rotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_call_logs" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "argsSummary" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "ms" INTEGER NOT NULL,
    "resultChars" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_clients_clientId_key" ON "mcp_clients"("clientId");

-- CreateIndex
CREATE INDEX "mcp_grants_userId_idx" ON "mcp_grants"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_auth_codes_codeHash_key" ON "mcp_auth_codes"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_tokens_tokenHash_key" ON "mcp_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "mcp_tokens_grantId_idx" ON "mcp_tokens"("grantId");

-- CreateIndex
CREATE INDEX "mcp_call_logs_createdAt_idx" ON "mcp_call_logs"("createdAt");

