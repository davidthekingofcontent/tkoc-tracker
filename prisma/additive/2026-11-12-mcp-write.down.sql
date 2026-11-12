-- Rollback of prisma/additive/2026-11-12-mcp-write.sql.
--
-- Drops ONLY the table of the write layer of the MCP connector (its indexes
-- go with it). Every action waiting for a confirmation is lost, and so is the
-- record of which confirm tokens were already used. The read layer's tables
-- are untouched.
-- Ship the code WITHOUT the write layer first, then run this.
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 \
--     -f prisma/additive/2026-11-12-mcp-write.down.sql

DROP TABLE IF EXISTS "mcp_pending_actions";
