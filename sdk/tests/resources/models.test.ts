import { describe, it, expect, vi } from "vitest";
import { createClient, jsonOk, jsonError } from "../helpers";

describe("ModelsResource", () => {
  it("list returns model array", async () => {
    const models = [
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
      { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
    ];
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ models }));
    const client = createClient(mockFetch);

    const result = await client.models.list();

    expect(result).toEqual(models);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/models");
    expect(init.method).toBe("GET");
  });

  it("throws AgentPlaneError on server error", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonError(500, { code: "internal_error", message: "Internal server error" }),
    );
    const client = createClient(mockFetch);

    await expect(client.models.list()).rejects.toThrow("Internal server error");
  });
});
