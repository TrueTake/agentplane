import { describe, it, expect, vi } from "vitest";
import { createClient, jsonOk, jsonError } from "../helpers";

describe("DashboardResource", () => {
  describe("stats", () => {
    it("returns dashboard stats", async () => {
      const stats = {
        agent_count: 5,
        total_runs: 120,
        active_runs: 2,
        total_spend: 45.67,
        session_count: 3,
      };
      const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk(stats));
      const client = createClient(mockFetch);

      const result = await client.dashboard.stats();

      expect(result).toEqual(stats);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/dashboard/stats");
      expect(init.method).toBe("GET");
    });

    it("throws on error", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        jsonError(401, { code: "unauthorized", message: "Invalid API key" }),
      );
      const client = createClient(mockFetch);

      await expect(client.dashboard.stats()).rejects.toThrow("Invalid API key");
    });
  });

  describe("charts", () => {
    it("returns daily agent stats with default days", async () => {
      const data = [
        { date: "2026-03-18", agent_name: "Agent A", run_count: 5, cost_usd: 1.23 },
        { date: "2026-03-19", agent_name: "Agent A", run_count: 3, cost_usd: 0.89 },
      ];
      const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ data }));
      const client = createClient(mockFetch);

      const result = await client.dashboard.charts();

      expect(result).toEqual(data);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/dashboard/charts");
    });

    it("passes days parameter", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ data: [] }));
      const client = createClient(mockFetch);

      await client.dashboard.charts({ days: 7 });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("days=7");
    });
  });
});
