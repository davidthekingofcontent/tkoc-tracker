-- Rollback of prisma/additive/2026-11-12-mcp.sql.
--
-- Drops ONLY the five tables of the MCP connector (their indexes go with
-- them). It deletes every connection of Claude, its tokens and the call log:
-- after it, each administrator has to connect Claude again.
-- Ship the code WITHOUT the connector first, then run this.
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 \
--     -f prisma/additive/2026-11-12-mcp.down.sql

DROP TABLE IF EXISTS "mcp_call_logs";
DROP TABLE IF EXISTS "mcp_tokens";
DROP TABLE IF EXISTS "mcp_auth_codes";
DROP TABLE IF EXISTS "mcp_grants";
DROP TABLE IF EXISTS "mcp_clients";
