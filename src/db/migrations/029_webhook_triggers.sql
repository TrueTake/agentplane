-- Webhook-triggered agent runs: adds 'webhook' to runs.triggered_by,
-- plus two new tenant-scoped tables (webhook_triggers + webhook_deliveries).

-- ============================================================
-- 1. Extend runs.triggered_by CHECK with 'webhook'
-- ============================================================
-- Pattern from migration 016: dynamic drop of any existing triggered_by
-- CHECK constraints, then re-add with 'webhook' included (NOT VALID → VALIDATE
-- to avoid ACCESS EXCLUSIVE lock on the runs table).
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
    WHERE con.conrelid = 'runs'::regclass
      AND con.contype = 'c'
      AND att.attname = 'triggered_by'
  LOOP
    EXECUTE format('ALTER TABLE runs DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE runs ADD CONSTRAINT runs_triggered_by_check
  CHECK (triggered_by IN ('api', 'schedule', 'playground', 'chat', 'a2a', 'webhook'))
  NOT VALID;
ALTER TABLE runs VALIDATE CONSTRAINT runs_triggered_by_check;

-- ============================================================
-- 2. Create webhook_triggers table
-- ============================================================
CREATE TABLE IF NOT EXISTS webhook_triggers (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL,
  agent_id                 UUID NOT NULL,
  toolkit_slug             VARCHAR(100) NOT NULL,
  trigger_type             VARCHAR(150) NOT NULL,
  composio_trigger_id      TEXT NOT NULL,
  prompt_template          TEXT NOT NULL,
  -- AgentPlane-side filter predicate, evaluated post-signature in the webhook route.
  -- Structure is a small dot-path → value map; NULL means "no filter".
  filter_predicate         JSONB,
  -- Dual-form allowlist entries per Unit 5:
  --   [{ "claude": "mcp__composio__LINEAR_CREATE_ISSUE",
  --      "aiSdk":  "LINEAR_CREATE_ISSUE" }, ...]
  -- Built at trigger-save time by the CRUD route (Unit 7).
  tool_allowlist           JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled                  BOOLEAN NOT NULL DEFAULT false,
  pending_cancel           BOOLEAN NOT NULL DEFAULT false,
  last_cancel_attempt_at   TIMESTAMPTZ,
  cancel_attempts          INTEGER NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composite FK: trigger's tenant must match agent's tenant.
  -- ON DELETE RESTRICT: agent delete must first mark triggers pending_cancel
  -- and commit (see Unit 7 agent-delete hook). This is the single supported
  -- cleanup path and prevents orphan Composio subscriptions.
  CONSTRAINT fk_webhook_triggers_agent_tenant
    FOREIGN KEY (agent_id, tenant_id)
    REFERENCES agents(id, tenant_id)
    ON DELETE RESTRICT,

  CONSTRAINT chk_webhook_triggers_tool_allowlist_is_array
    CHECK (jsonb_typeof(tool_allowlist) = 'array')
);

-- Required by composite FK from webhook_deliveries (Postgres requires
-- parent-side uniqueness on composite FK columns; mirrors agents_id_tenant_id_unique).
ALTER TABLE webhook_triggers
  ADD CONSTRAINT webhook_triggers_id_tenant_id_unique UNIQUE (id, tenant_id);

-- Dedup per (tenant, agent, composio subscription).
CREATE UNIQUE INDEX idx_webhook_triggers_composio_unique
  ON webhook_triggers (tenant_id, agent_id, composio_trigger_id);

-- Hot path: webhook route lookup by composio_trigger_id (from signed metadata).
CREATE INDEX idx_webhook_triggers_composio_id
  ON webhook_triggers (composio_trigger_id);

-- Tenant-scoped list queries.
CREATE INDEX idx_webhook_triggers_tenant ON webhook_triggers (tenant_id);

-- Agent-scoped list queries (Triggers tab).
CREATE INDEX idx_webhook_triggers_agent ON webhook_triggers (agent_id);

-- Cascade-cancel cron claim.
CREATE INDEX idx_webhook_triggers_pending_cancel
  ON webhook_triggers (last_cancel_attempt_at)
  WHERE pending_cancel = true;

-- ============================================================
-- 3. RLS on webhook_triggers
-- ============================================================
ALTER TABLE webhook_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_triggers FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON webhook_triggers
  FOR ALL TO app_user
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE TRIGGER webhook_triggers_updated_at
  BEFORE UPDATE ON webhook_triggers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_triggers TO app_user;

-- ============================================================
-- 4. Create webhook_deliveries table
-- ============================================================
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL,
  webhook_trigger_id    UUID NOT NULL,
  -- Global envelope-id dedup. The webhook route INSERTs with
  -- ON CONFLICT (composio_event_id) DO NOTHING to reject replays.
  composio_event_id     TEXT NOT NULL,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Status is 'received' at insert time; downstream branches UPDATE to a
  -- terminal value. The 8-enum set covers every ingress outcome including
  -- the non-terminal intake state.
  status                VARCHAR(40) NOT NULL
                        CHECK (status IN (
                          'received',
                          'accepted',
                          'rejected_429',
                          'signature_failed',
                          'trigger_disabled',
                          'budget_blocked',
                          'filtered',
                          'run_failed_to_create'
                        )),
  run_id                UUID REFERENCES runs(id) ON DELETE SET NULL,
  -- JSONB holding the { version, iv, ciphertext } object from crypto.encrypt().
  -- Plaintext payload is JSON.stringify'd and sliced to 16 KB before encryption.
  payload_snapshot      JSONB,
  payload_truncated     BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composite FK: delivery's tenant must match trigger's tenant.
  CONSTRAINT fk_webhook_deliveries_trigger_tenant
    FOREIGN KEY (webhook_trigger_id, tenant_id)
    REFERENCES webhook_triggers(id, tenant_id)
    ON DELETE CASCADE
);

-- Envelope-id dedup.
CREATE UNIQUE INDEX idx_webhook_deliveries_event_id
  ON webhook_deliveries (composio_event_id);

-- Delivery-log list query (Admin UI).
CREATE INDEX idx_webhook_deliveries_list
  ON webhook_deliveries (tenant_id, webhook_trigger_id, received_at DESC);

-- TTL cleanup cron.
CREATE INDEX idx_webhook_deliveries_received_at
  ON webhook_deliveries (received_at);

-- ============================================================
-- 5. RLS on webhook_deliveries
-- ============================================================
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON webhook_deliveries
  FOR ALL TO app_user
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE TRIGGER webhook_deliveries_updated_at
  BEFORE UPDATE ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_deliveries TO app_user;
