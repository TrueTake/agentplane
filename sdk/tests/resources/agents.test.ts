import { describe, it, expect, vi } from "vitest";
import { createClient, jsonOk, jsonError } from "../helpers";
import type { Agent } from "../../src/types";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_1",
    tenant_id: "tenant_1",
    name: "Test Agent",
    description: null,
    slug: "test-agent",
    git_repo_url: null,
    git_branch: "main",
    composio_toolkits: [],
    composio_mcp_server_id: null,
    composio_mcp_server_name: null,
    composio_allowed_tools: [],
    skills: [],
    plugins: [],
    model: "claude-sonnet-4-6",
    runner: "claude-agent-sdk",
    allowed_tools: [],
    permission_mode: "default",
    max_turns: 10,
    max_budget_usd: 1,
    max_runtime_seconds: 600,
    a2a_enabled: false,
    a2a_tags: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("AgentsResource", () => {
  it("create sends POST /api/agents", async () => {
    const agent = makeAgent();
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk(agent));
    const client = createClient(mockFetch);

    const result = await client.agents.create({ name: "Test Agent" });

    expect(result).toEqual(agent);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/agents");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "Test Agent" });
  });

  it("get sends GET /api/agents/:id", async () => {
    const agent = makeAgent();
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk(agent));
    const client = createClient(mockFetch);

    const result = await client.agents.get("agent_1");

    expect(result).toEqual(agent);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/agents/agent_1");
    expect(init.method).toBe("GET");
  });

  it("list returns paginated agents with has_more", async () => {
    const agents = [makeAgent(), makeAgent({ id: "agent_2", name: "Agent 2" })];
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonOk({ data: agents, limit: 20, offset: 0 }),
    );
    const client = createClient(mockFetch);

    const result = await client.agents.list({ limit: 20, offset: 0 });

    expect(result.data).toEqual(agents);
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
    expect(result.has_more).toBe(false); // 2 < 20
  });

  it("list sets has_more true when data.length === limit", async () => {
    const agents = Array.from({ length: 5 }, (_, i) =>
      makeAgent({ id: `agent_${i}`, name: `Agent ${i}` }),
    );
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonOk({ data: agents, limit: 5, offset: 0 }),
    );
    const client = createClient(mockFetch);

    const result = await client.agents.list({ limit: 5 });

    expect(result.has_more).toBe(true);
  });

  it("list works without params", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonOk({ data: [], limit: 20, offset: 0 }),
    );
    const client = createClient(mockFetch);

    const result = await client.agents.list();

    expect(result.data).toEqual([]);
  });

  it("update sends PUT /api/agents/:id", async () => {
    const updated = makeAgent({ name: "Updated" });
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk(updated));
    const client = createClient(mockFetch);

    const result = await client.agents.update("agent_1", { name: "Updated" });

    expect(result.name).toBe("Updated");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/agents/agent_1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ name: "Updated" });
  });

  it("delete sends DELETE /api/agents/:id", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ deleted: true }));
    const client = createClient(mockFetch);

    await client.agents.delete("agent_1");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/agents/agent_1");
    expect(init.method).toBe("DELETE");
  });

  it("throws AgentPlaneError on 404", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonError(404, { code: "not_found", message: "Agent not found" }),
    );
    const client = createClient(mockFetch);

    await expect(client.agents.get("nonexistent")).rejects.toThrow("Agent not found");
  });

  it("create with full params sends all fields", async () => {
    const agent = makeAgent({ model: "openai/gpt-4o", runner: "vercel-ai-sdk" });
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk(agent));
    const client = createClient(mockFetch);

    const params = {
      name: "Full Agent",
      description: "A test agent",
      model: "openai/gpt-4o",
      max_turns: 20,
      max_budget_usd: 5,
      max_runtime_seconds: 1200,
      permission_mode: "bypassPermissions" as const,
      a2a_enabled: true,
    };

    await client.agents.create(params);

    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual(params);
  });
});
