-- Add context_id column to sessions for A2A multi-turn sandbox reuse
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS context_id TEXT;

-- Unique partial index: only one active/idle/creating session per (tenant, agent, context_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_context_id_active
  ON sessions (tenant_id, agent_id, context_id)
  WHERE status NOT IN ('stopped') AND context_id IS NOT NULL;
