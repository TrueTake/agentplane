import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to test the module's internal functions via the exported listCatalogModels.
// The module has process-level cache, so we re-import fresh for each test.

describe("model-catalog", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    vi.restoreAllMocks();
  });

  it("returns fallback models when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const { listCatalogModels } = await import("@/lib/model-catalog");

    const models = await listCatalogModels();

    expect(models.length).toBeGreaterThan(0);
    // Check that fallback includes known models
    const ids = models.map((m) => m.id);
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("openai/gpt-4o");
  });

  it("returns fallback models when fetch returns non-200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    const { listCatalogModels } = await import("@/lib/model-catalog");

    const models = await listCatalogModels();

    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id).toBe("claude-sonnet-4-6");
  });

  it("returns fallback models when response fails validation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ invalid: "schema" }),
      }),
    );
    const { listCatalogModels } = await import("@/lib/model-catalog");

    const models = await listCatalogModels();

    expect(models.length).toBeGreaterThan(0);
  });

  it("parses valid gateway response", async () => {
    const gatewayResponse = {
      data: [
        {
          id: "anthropic/claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          owned_by: "anthropic",
          context_window: 1_000_000,
          max_tokens: 64_000,
          type: "language",
          tags: ["reasoning", "tool-use"],
          pricing: { input: "0.000003", output: "0.000015" },
        },
        {
          id: "openai/gpt-4o",
          name: "GPT-4o",
          owned_by: "openai",
          context_window: 128_000,
          max_tokens: 16_384,
          type: "language",
          tags: ["tool-use", "vision"],
          pricing: { input: "0.0000025", output: "0.00001" },
        },
        {
          id: "openai/text-embedding-3-large",
          name: "Embedding Large",
          owned_by: "openai",
          context_window: 8192,
          max_tokens: null,
          type: "embedding",
          tags: [],
          pricing: { input: "0.00000013", output: null },
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(gatewayResponse),
      }),
    );
    const { listCatalogModels } = await import("@/lib/model-catalog");

    const models = await listCatalogModels();

    // Should filter out embedding model
    expect(models.length).toBe(2);

    // Anthropic model should have bare ID (strip "anthropic/" prefix)
    const claude = models.find((m) => m.id === "claude-sonnet-4-6");
    expect(claude).toBeDefined();
    expect(claude!.provider).toBe("anthropic");
    expect(claude!.default_runner).toBe("claude-agent-sdk");
    expect(claude!.supports_claude_runner).toBe(true);
    expect(claude!.pricing.inputPerMillionTokens).toBe(3);
    expect(claude!.pricing.outputPerMillionTokens).toBe(15);

    // OpenAI model should keep prefix
    const gpt = models.find((m) => m.id === "openai/gpt-4o");
    expect(gpt).toBeDefined();
    expect(gpt!.provider).toBe("openai");
    expect(gpt!.default_runner).toBe("vercel-ai-sdk");
    expect(gpt!.supports_claude_runner).toBe(false);
  });

  it("uses cached results within TTL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            {
              id: "anthropic/claude-sonnet-4-6",
              name: "Claude Sonnet 4.6",
              owned_by: "anthropic",
              context_window: 1_000_000,
              max_tokens: 64_000,
              type: "language",
              tags: [],
              pricing: { input: "0.000003", output: "0.000015" },
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const { listCatalogModels } = await import("@/lib/model-catalog");

    await listCatalogModels();
    await listCatalogModels();

    // Should only fetch once due to caching
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("fallback models have correct runner assignments", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fail")));
    const { listCatalogModels } = await import("@/lib/model-catalog");

    const models = await listCatalogModels();

    for (const model of models) {
      if (model.provider === "anthropic") {
        expect(model.default_runner).toBe("claude-agent-sdk");
        expect(model.supports_claude_runner).toBe(true);
      } else {
        expect(model.default_runner).toBe("vercel-ai-sdk");
        expect(model.supports_claude_runner).toBe(false);
      }
    }
  });
});
