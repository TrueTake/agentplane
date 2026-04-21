import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @/db so helpers can be exercised without a live Postgres.
vi.mock("@/db", () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn().mockResolvedValue({ rowCount: 0 }),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// Use a stable 32-byte (64 hex char) key for encrypt/decrypt round-trip.
const TEST_ENCRYPTION_KEY = "a".repeat(64);

vi.mock("@/lib/env", () => ({
  getEnv: vi.fn(() => ({
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    ENCRYPTION_KEY_PREVIOUS: undefined,
  })),
}));

import {
  countActiveTriggers,
  decryptDeliveryPayload,
  encryptDeliveryPayload,
  insertTrigger,
  listTriggers,
  markTriggerPendingCancel,
  markTriggersPendingCancelForAgent,
  markTriggersPendingCancelForToolkit,
  updateTrigger,
} from "@/lib/webhook-triggers";
import { query, queryOne, execute } from "@/db";
import type { AgentId, TenantId, WebhookTriggerId } from "@/lib/types";

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockQueryOne = queryOne as unknown as ReturnType<typeof vi.fn>;
const mockExecute = execute as unknown as ReturnType<typeof vi.fn>;

const agentId = "agent-1" as AgentId;
const tenantId = "tenant-1" as TenantId;
const triggerId = "trigger-1" as WebhookTriggerId;

const mockRow = {
  id: triggerId,
  tenant_id: tenantId,
  agent_id: agentId,
  toolkit_slug: "linear",
  trigger_type: "LINEAR_ISSUE_CREATED",
  composio_trigger_id: "ti_abc",
  prompt_template: "hello",
  filter_predicate: null,
  tool_allowlist: [],
  enabled: true,
  pending_cancel: false,
  last_cancel_attempt_at: null,
  cancel_attempts: 0,
  created_at: new Date(),
  updated_at: new Date(),
};

describe("webhook-triggers helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue({ rowCount: 0 });
  });

  describe("listTriggers", () => {
    it("queries by agent_id, ordered by created_at", async () => {
      mockQuery.mockResolvedValue([mockRow]);
      const rows = await listTriggers(agentId);
      expect(rows).toHaveLength(1);
      const call = mockQuery.mock.calls[0];
      expect(call[1]).toContain("FROM webhook_triggers");
      expect(call[1]).toContain("WHERE agent_id = $1");
      expect(call[1]).toContain("ORDER BY created_at");
      expect(call[2]).toEqual([agentId]);
    });
  });

  describe("insertTrigger", () => {
    it("INSERTs with JSON-serialized JSONB cols and returns parsed row", async () => {
      mockQueryOne.mockResolvedValue(mockRow);
      const row = await insertTrigger({
        tenantId,
        agentId,
        toolkitSlug: "linear",
        triggerType: "LINEAR_ISSUE_CREATED",
        composioTriggerId: "ti_abc",
        promptTemplate: "hello",
        filterPredicate: { "data.state": "Triage" },
        toolAllowlist: [{ claude: "mcp__a__b", aiSdk: "B" }],
        enabled: true,
      });
      expect(row.id).toBe(triggerId);
      const params = mockQueryOne.mock.calls[0][2];
      // Both JSONB params should be serialized strings.
      expect(params[6]).toBe(JSON.stringify({ "data.state": "Triage" }));
      expect(params[7]).toBe(JSON.stringify([{ claude: "mcp__a__b", aiSdk: "B" }]));
    });

    it("throws when RETURNING yields no row", async () => {
      mockQueryOne.mockResolvedValue(null);
      await expect(
        insertTrigger({
          tenantId,
          agentId,
          toolkitSlug: "linear",
          triggerType: "X",
          composioTriggerId: "ti",
          promptTemplate: "p",
          filterPredicate: null,
          toolAllowlist: [],
          enabled: false,
        }),
      ).rejects.toThrow(/INSERT/);
    });
  });

  describe("updateTrigger", () => {
    it("builds a dynamic SET clause from provided fields only", async () => {
      mockQueryOne.mockResolvedValue(mockRow);
      await updateTrigger(triggerId, { enabled: false, promptTemplate: "new" });
      const sql = mockQueryOne.mock.calls[0][1];
      expect(sql).toContain("prompt_template = $1");
      expect(sql).toContain("enabled = $2");
      expect(sql).toContain("updated_at = NOW()");
      const params = mockQueryOne.mock.calls[0][2];
      expect(params).toEqual(["new", false, triggerId]);
    });

    it("serializes filter_predicate to JSON string when set", async () => {
      mockQueryOne.mockResolvedValue(mockRow);
      await updateTrigger(triggerId, { filterPredicate: { k: "v" } });
      const params = mockQueryOne.mock.calls[0][2];
      expect(params[0]).toBe(JSON.stringify({ k: "v" }));
    });

    it("returns current row when patch is empty", async () => {
      mockQueryOne.mockResolvedValue(mockRow);
      const row = await updateTrigger(triggerId, {});
      expect(row?.id).toBe(triggerId);
      // Only one call — getTriggerById — no UPDATE.
      expect(mockQueryOne).toHaveBeenCalledTimes(1);
      const sql = mockQueryOne.mock.calls[0][1];
      expect(sql).toContain("SELECT * FROM webhook_triggers");
    });
  });

  describe("markTriggerPendingCancel", () => {
    it("sets both pending_cancel = true and enabled = false", async () => {
      mockExecute.mockResolvedValue({ rowCount: 1 });
      await markTriggerPendingCancel(triggerId);
      const call = mockExecute.mock.calls[0];
      expect(call[0]).toContain("pending_cancel = true");
      expect(call[0]).toContain("enabled = false");
      expect(call[1]).toEqual([triggerId]);
    });
  });

  describe("markTriggersPendingCancelForAgent", () => {
    it("returns rowCount and filters out already-pending rows", async () => {
      mockExecute.mockResolvedValue({ rowCount: 3 });
      const n = await markTriggersPendingCancelForAgent(agentId);
      expect(n).toBe(3);
      const sql = mockExecute.mock.calls[0][0];
      expect(sql).toContain("WHERE agent_id = $1");
      expect(sql).toContain("pending_cancel = false");
    });
  });

  describe("markTriggersPendingCancelForToolkit", () => {
    it("filters by agent + toolkit_slug (lowercased)", async () => {
      mockExecute.mockResolvedValue({ rowCount: 2 });
      const n = await markTriggersPendingCancelForToolkit(agentId, "LINEAR");
      expect(n).toBe(2);
      const params = mockExecute.mock.calls[0][1];
      expect(params).toEqual([agentId, "linear"]);
    });
  });

  describe("countActiveTriggers", () => {
    it("excludes pending_cancel rows in the COUNT", async () => {
      mockQueryOne.mockResolvedValue({ count: 4 });
      const n = await countActiveTriggers(agentId);
      expect(n).toBe(4);
      const sql = mockQueryOne.mock.calls[0][1];
      expect(sql).toContain("enabled = true");
      expect(sql).toContain("pending_cancel = false");
    });

    it("returns 0 when COUNT row is null", async () => {
      mockQueryOne.mockResolvedValue(null);
      expect(await countActiveTriggers(agentId)).toBe(0);
    });
  });

  describe("decryptDeliveryPayload", () => {
    it("round-trips an encrypted payload via encrypt + decrypt", async () => {
      const plaintext = JSON.stringify({ issue: { id: 42, state: "Triage" } });
      const encrypted = await encryptDeliveryPayload(plaintext, TEST_ENCRYPTION_KEY);
      const result = await decryptDeliveryPayload({
        payload_snapshot: encrypted,
        payload_truncated: false,
      });
      expect(result).not.toBeNull();
      expect(result!.plaintext).toBe(plaintext);
      expect(result!.truncated).toBe(false);
    });

    it("returns null when payload_snapshot is null", async () => {
      const result = await decryptDeliveryPayload({
        payload_snapshot: null,
        payload_truncated: false,
      });
      expect(result).toBeNull();
    });

    it("preserves the truncated flag", async () => {
      const encrypted = await encryptDeliveryPayload("x", TEST_ENCRYPTION_KEY);
      const result = await decryptDeliveryPayload({
        payload_snapshot: encrypted,
        payload_truncated: true,
      });
      expect(result!.truncated).toBe(true);
    });
  });
});
