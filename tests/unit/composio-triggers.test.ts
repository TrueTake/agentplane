import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  __setComposioCoreClientForTests,
  createTrigger,
  deleteTrigger,
  disableTrigger,
  enableTrigger,
  getTrigger,
  listTriggerTypes,
  sanitizeComposioTriggersError,
} from "@/lib/composio-triggers";

interface MockedTriggers {
  listTypes: ReturnType<typeof vi.fn>;
  listActive: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  enable: ReturnType<typeof vi.fn>;
  disable: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function makeMockClient(): { triggers: MockedTriggers } {
  return {
    triggers: {
      listTypes: vi.fn(),
      listActive: vi.fn(),
      create: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      delete: vi.fn(),
    },
  };
}

describe("composio-triggers", () => {
  let mock: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    mock = makeMockClient();
    // Cast to unknown first — we only exercise the triggers.* surface.
    __setComposioCoreClientForTests(mock as unknown as Parameters<typeof __setComposioCoreClientForTests>[0]);
  });

  afterEach(() => {
    __setComposioCoreClientForTests(null);
  });

  describe("createTrigger", () => {
    it("returns the composioTriggerId parsed from the SDK response", async () => {
      mock.triggers.create.mockResolvedValue({ triggerId: "ti_abc123" });

      const res = await createTrigger({
        userId: "tenant-1",
        triggerType: "LINEAR_ISSUE_CREATED",
        connectedAccountId: "ca_999",
      });

      expect(res).toEqual({ composioTriggerId: "ti_abc123" });
      expect(mock.triggers.create).toHaveBeenCalledWith(
        "tenant-1",
        "LINEAR_ISSUE_CREATED",
        expect.objectContaining({ connectedAccountId: "ca_999" }),
      );
    });

    it("wraps SDK errors in a sanitized message", async () => {
      mock.triggers.create.mockRejectedValue(new Error("Internal server error 500"));

      await expect(
        createTrigger({ userId: "t", triggerType: "X", connectedAccountId: "c" }),
      ).rejects.toThrow(/Composio upstream error/);
    });
  });

  describe("deleteTrigger", () => {
    it("returns alreadyGone: false on successful deletion", async () => {
      mock.triggers.delete.mockResolvedValue({ status: "deleted" });
      const res = await deleteTrigger("ti_1");
      expect(res).toEqual({ alreadyGone: false });
    });

    it("returns alreadyGone: true on 404 (idempotent)", async () => {
      const err = Object.assign(new Error("trigger not found"), { status: 404 });
      mock.triggers.delete.mockRejectedValue(err);
      const res = await deleteTrigger("ti_missing");
      expect(res).toEqual({ alreadyGone: true });
    });

    it("surfaces sanitized error for non-404 failures", async () => {
      mock.triggers.delete.mockRejectedValue(new Error("boom"));
      await expect(deleteTrigger("ti_1")).rejects.toThrow(/Composio upstream error/);
    });
  });

  describe("enable/disable", () => {
    it("enable calls triggers.enable with the id", async () => {
      mock.triggers.enable.mockResolvedValue({});
      await enableTrigger("ti_1");
      expect(mock.triggers.enable).toHaveBeenCalledWith("ti_1");
    });

    it("disable calls triggers.disable with the id", async () => {
      mock.triggers.disable.mockResolvedValue({});
      await disableTrigger("ti_1");
      expect(mock.triggers.disable).toHaveBeenCalledWith("ti_1");
    });
  });

  describe("listTriggerTypes", () => {
    it("returns the normalized trigger type list", async () => {
      mock.triggers.listTypes.mockResolvedValue({
        items: [
          {
            slug: "LINEAR_ISSUE_CREATED",
            name: "Linear Issue Created",
            description: "Fires when an issue is created",
            instructions: "pick a team",
            toolkit: { slug: "linear", name: "Linear", logo: "https://logo" },
          },
        ],
      });

      const res = await listTriggerTypes("linear");
      expect(res).toHaveLength(1);
      expect(res[0]!.slug).toBe("LINEAR_ISSUE_CREATED");
      expect(res[0]!.toolkit.slug).toBe("linear");
    });

    it("returns [] when COMPOSIO_API_KEY is not configured", async () => {
      __setComposioCoreClientForTests(null);
      const previous = process.env.COMPOSIO_API_KEY;
      delete process.env.COMPOSIO_API_KEY;
      try {
        const res = await listTriggerTypes("linear");
        expect(res).toEqual([]);
      } finally {
        if (previous !== undefined) process.env.COMPOSIO_API_KEY = previous;
      }
    });
  });

  describe("getTrigger", () => {
    it("returns null when the SDK returns an empty list", async () => {
      mock.triggers.listActive.mockResolvedValue({ items: [] });
      const res = await getTrigger("ti_1");
      expect(res).toBeNull();
    });

    it("returns null on 404 errors", async () => {
      mock.triggers.listActive.mockRejectedValue(
        Object.assign(new Error("404 not found"), { status: 404 }),
      );
      expect(await getTrigger("ti_1")).toBeNull();
    });

    it("maps the state field to the 3-value union", async () => {
      mock.triggers.listActive.mockResolvedValue({
        items: [{ id: "ti_1", state: "enabled", triggerName: "t", connectedAccountId: "ca_1" }],
      });
      const res = await getTrigger("ti_1");
      expect(res?.state).toBe("enabled");

      mock.triggers.listActive.mockResolvedValue({
        items: [{ id: "ti_1", state: "something_weird" }],
      });
      expect((await getTrigger("ti_1"))?.state).toBe("unknown");
    });
  });

  describe("sanitizeComposioTriggersError", () => {
    it("maps common failure categories to safe messages", () => {
      expect(sanitizeComposioTriggersError(new Error("not found"))).toMatch(/not found/i);
      expect(sanitizeComposioTriggersError(new Error("invalid request"))).toMatch(/invalid/i);
      expect(sanitizeComposioTriggersError(new Error("Unauthorized 401"))).toMatch(/authorization/i);
      expect(sanitizeComposioTriggersError(new Error("request timeout"))).toMatch(/timeout/i);
      expect(sanitizeComposioTriggersError(new Error("random boom"))).toMatch(/upstream error/);
    });
  });
});
