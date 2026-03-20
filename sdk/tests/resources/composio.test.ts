import { describe, it, expect, vi } from "vitest";
import { createClient, jsonOk, jsonError } from "../helpers";

describe("ComposioResource", () => {
  it("toolkits returns toolkit array", async () => {
    const toolkits = [
      { slug: "github", name: "GitHub", logo: "https://example.com/github.png" },
      { slug: "slack", name: "Slack", logo: "https://example.com/slack.png" },
    ];
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ data: toolkits }));
    const client = createClient(mockFetch);

    const result = await client.composio.toolkits();

    expect(result).toEqual(toolkits);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/composio/toolkits");
    expect(init.method).toBe("GET");
  });

  it("tools returns tool array for a toolkit", async () => {
    const tools = [
      { slug: "github_create_issue", name: "Create Issue", description: "Create a GitHub issue" },
    ];
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ data: tools }));
    const client = createClient(mockFetch);

    const result = await client.composio.tools("github");

    expect(result).toEqual(tools);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/composio/tools");
    expect(url).toContain("toolkit=github");
  });

  it("throws on error", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonError(500, { code: "internal_error", message: "Internal server error" }),
    );
    const client = createClient(mockFetch);

    await expect(client.composio.toolkits()).rejects.toThrow("Internal server error");
  });
});
