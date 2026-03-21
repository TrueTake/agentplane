import { describe, it, expect, vi } from "vitest";
import { createClient, jsonOk, jsonError } from "../helpers";

describe("KeysResource", () => {
  it("list returns array of API keys", async () => {
    const keys = [
      {
        id: "key_1",
        name: "Production",
        key_prefix: "ap_live_abcd",
        scopes: ["*"],
        last_used_at: null,
        expires_at: null,
        revoked_at: null,
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ data: keys }));
    const client = createClient(mockFetch);

    const result = await client.keys.list();

    expect(result).toEqual(keys);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/keys");
    expect(init.method).toBe("GET");
  });

  it("create sends POST /api/keys", async () => {
    const response = { id: "key_2", key: "ap_live_full_key_here", name: "New Key" };
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk(response));
    const client = createClient(mockFetch);

    const result = await client.keys.create({ name: "New Key" });

    expect(result).toEqual(response);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/keys");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "New Key" });
  });

  it("revoke sends DELETE /api/keys/:id", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonOk({ deleted: true }));
    const client = createClient(mockFetch);

    await client.keys.revoke("key_1");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/keys/key_1");
    expect(init.method).toBe("DELETE");
  });

  it("throws on error response", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonError(403, { code: "forbidden", message: "Not authorized" }),
    );
    const client = createClient(mockFetch);

    await expect(client.keys.list()).rejects.toThrow("Not authorized");
  });
});
