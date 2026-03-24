-- Track when MCP tokens were last refreshed for a session.
-- Enables fast-path reconnect: skip MCP/plugin refresh if tokens are still fresh.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mcp_refreshed_at TIMESTAMPTZ;
