-- Partial index for Agent Card queries (only indexes the small set of A2A-enabled agents)
CREATE INDEX IF NOT EXISTS idx_agents_a2a_enabled ON agents (tenant_id) WHERE a2a_enabled = true;
