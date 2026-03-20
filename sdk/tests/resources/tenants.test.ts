import { describe, it, expect, vi } from "vitest";
import { createClient, jsonOk, jsonError } from "../helpers";

const SAMPLE_TENANT = {
  id: "t_1",
  name: "Acme Corp",
  slug: "acme",
  settings: {},
  monthly_budget_usd: 100,
  status: "active" as const,
  current_month_spend: 25.5,
  timezone: "America/New_York",
  logo_url: null,
  spend_period_start: "2026-03-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
};

describe("TenantsResource", () => {
  it("getMe returns current tenant", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk(SAMPLE_TENANT));
    const client = createClient(mockFetch);

    const result = await client.tenants.getMe();

    expect(result).toEqual(SAMPLE_TENANT);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/tenants/me");
    expect(init.method).toBe("GET");
  });

  it("updateMe sends PATCH with body", async () => {
    const updated = { ...SAMPLE_TENANT, name: "Acme Inc" };
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk(updated));
    const client = createClient(mockFetch);

    const result = await client.tenants.updateMe({ name: "Acme Inc" });

    expect(result.name).toBe("Acme Inc");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/tenants/me");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ name: "Acme Inc" });
  });

  it("updateMe supports all fields", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk(SAMPLE_TENANT));
    const client = createClient(mockFetch);

    await client.tenants.updateMe({
      name: "New Name",
      timezone: "Europe/London",
      monthly_budget_usd: 200,
      logo_url: "https://example.com/logo.png",
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.name).toBe("New Name");
    expect(body.timezone).toBe("Europe/London");
    expect(body.monthly_budget_usd).toBe(200);
    expect(body.logo_url).toBe("https://example.com/logo.png");
  });

  it("throws on error", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonError(404, { code: "not_found", message: "Tenant not found" }),
    );
    const client = createClient(mockFetch);

    await expect(client.tenants.getMe()).rejects.toThrow("Tenant not found");
  });
});
