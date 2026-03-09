import { describe, it, expect } from "vitest";
import {
  validateMetadataOrigin,
  getBaseDomain,
  generatePkceChallenge,
} from "@/lib/mcp-oauth";
import type { OAuthMetadata } from "@/lib/types";

const baseMetadata: OAuthMetadata = {
  issuer: "https://mcp.example.com",
  authorization_endpoint: "https://mcp.example.com/authorize",
  token_endpoint: "https://mcp.example.com/token",
  response_types_supported: ["code"],
};

describe("getBaseDomain", () => {
  it("returns two-label domains as-is", () => {
    expect(getBaseDomain("example.com")).toBe("example.com");
  });

  it("extracts base domain from subdomain", () => {
    expect(getBaseDomain("mcp.example.com")).toBe("example.com");
    expect(getBaseDomain("mcp-auth.granola.ai")).toBe("granola.ai");
  });

  it("extracts base domain from deeply nested subdomain", () => {
    expect(getBaseDomain("a.b.c.example.com")).toBe("example.com");
  });

  it("handles two-part TLDs", () => {
    expect(getBaseDomain("mcp.example.co.uk")).toBe("example.co.uk");
    expect(getBaseDomain("auth.mcp.example.co.uk")).toBe("example.co.uk");
  });
});

describe("validateMetadataOrigin", () => {
  it("accepts metadata where all URLs share the same origin", () => {
    expect(() =>
      validateMetadataOrigin(baseMetadata, "https://mcp.example.com"),
    ).not.toThrow();
  });

  it("accepts metadata with registration_endpoint on same origin", () => {
    const metadata = {
      ...baseMetadata,
      registration_endpoint: "https://mcp.example.com/register",
    };
    expect(() =>
      validateMetadataOrigin(metadata, "https://mcp.example.com"),
    ).not.toThrow();
  });

  it("accepts metadata with endpoints on a subdomain of the same base domain", () => {
    const metadata: OAuthMetadata = {
      issuer: "https://mcp-auth.granola.ai",
      authorization_endpoint: "https://mcp-auth.granola.ai/oauth2/authorize",
      token_endpoint: "https://mcp-auth.granola.ai/oauth2/token",
      registration_endpoint: "https://mcp-auth.granola.ai/oauth2/register",
      response_types_supported: ["code"],
    };
    expect(() =>
      validateMetadataOrigin(metadata, "https://mcp.granola.ai"),
    ).not.toThrow();
  });

  it("rejects metadata where token_endpoint has different base domain", () => {
    const metadata = {
      ...baseMetadata,
      token_endpoint: "https://evil.com/token",
    };
    expect(() =>
      validateMetadataOrigin(metadata, "https://mcp.example.com"),
    ).toThrow(/different base domain/);
  });

  it("rejects metadata where authorization_endpoint has different base domain", () => {
    const metadata = {
      ...baseMetadata,
      authorization_endpoint: "https://evil.com/authorize",
    };
    expect(() =>
      validateMetadataOrigin(metadata, "https://mcp.example.com"),
    ).toThrow(/different base domain/);
  });

  it("rejects metadata where registration_endpoint has different base domain", () => {
    const metadata = {
      ...baseMetadata,
      registration_endpoint: "https://evil.com/register",
    };
    expect(() =>
      validateMetadataOrigin(metadata, "https://mcp.example.com"),
    ).toThrow(/different base domain/);
  });

  it("rejects metadata with HTTP endpoint URL", () => {
    const metadata = {
      ...baseMetadata,
      token_endpoint: "http://mcp.example.com/token",
    };
    expect(() =>
      validateMetadataOrigin(metadata, "https://mcp.example.com"),
    ).toThrow(/must use HTTPS/);
  });

  it("ignores undefined registration_endpoint", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { registration_endpoint: _unused, ...metadata } = {
      ...baseMetadata,
      registration_endpoint: undefined,
    };
    expect(() =>
      validateMetadataOrigin(metadata, "https://mcp.example.com"),
    ).not.toThrow();
  });
});

describe("generatePkceChallenge", () => {
  it("generates a code_verifier and code_challenge", async () => {
    const { codeVerifier, codeChallenge } = await generatePkceChallenge();
    expect(codeVerifier).toBeTruthy();
    expect(codeChallenge).toBeTruthy();
    expect(codeVerifier).not.toBe(codeChallenge);
  });

  it("generates URL-safe characters (no +, /, =)", async () => {
    const { codeVerifier, codeChallenge } = await generatePkceChallenge();
    expect(codeVerifier).not.toMatch(/[+/=]/);
    expect(codeChallenge).not.toMatch(/[+/=]/);
  });

  it("generates unique values each call", async () => {
    const a = await generatePkceChallenge();
    const b = await generatePkceChallenge();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });

  it("generates code_verifier of at least 43 characters (RFC 7636)", async () => {
    const { codeVerifier } = await generatePkceChallenge();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
  });
});
