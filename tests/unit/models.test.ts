import { describe, it, expect } from "vitest";
import {
  defaultRunnerForModel,
  supportsClaudeRunner,
  resolveEffectiveRunner,
  isPermissionModeAllowed,
} from "@/lib/models";

describe("defaultRunnerForModel", () => {
  it("returns claude-agent-sdk for bare Anthropic model IDs", () => {
    expect(defaultRunnerForModel("claude-sonnet-4-6")).toBe("claude-agent-sdk");
    expect(defaultRunnerForModel("claude-opus-4-6")).toBe("claude-agent-sdk");
    expect(defaultRunnerForModel("claude-haiku-4-5-20251001")).toBe("claude-agent-sdk");
  });

  it("returns claude-agent-sdk for anthropic/ prefixed models", () => {
    expect(defaultRunnerForModel("anthropic/claude-sonnet-4-6")).toBe("claude-agent-sdk");
  });

  it("returns vercel-ai-sdk for non-Anthropic models", () => {
    expect(defaultRunnerForModel("openai/gpt-4o")).toBe("vercel-ai-sdk");
    expect(defaultRunnerForModel("google/gemini-2.5-pro")).toBe("vercel-ai-sdk");
    expect(defaultRunnerForModel("mistral/mistral-large")).toBe("vercel-ai-sdk");
    expect(defaultRunnerForModel("xai/grok-3")).toBe("vercel-ai-sdk");
    expect(defaultRunnerForModel("deepseek/deepseek-chat")).toBe("vercel-ai-sdk");
  });
});

describe("supportsClaudeRunner", () => {
  it("returns true for Anthropic models", () => {
    expect(supportsClaudeRunner("claude-sonnet-4-6")).toBe(true);
    expect(supportsClaudeRunner("anthropic/claude-opus-4-6")).toBe(true);
  });

  it("returns false for non-Anthropic models", () => {
    expect(supportsClaudeRunner("openai/gpt-4o")).toBe(false);
    expect(supportsClaudeRunner("google/gemini-2.5-pro")).toBe(false);
  });
});

describe("resolveEffectiveRunner", () => {
  it("uses agent runner for Anthropic models when set", () => {
    expect(resolveEffectiveRunner("claude-sonnet-4-6", "vercel-ai-sdk")).toBe("vercel-ai-sdk");
    expect(resolveEffectiveRunner("claude-sonnet-4-6", "claude-agent-sdk")).toBe("claude-agent-sdk");
  });

  it("defaults for Anthropic models when no agent runner set", () => {
    expect(resolveEffectiveRunner("claude-sonnet-4-6", null)).toBe("claude-agent-sdk");
    expect(resolveEffectiveRunner("claude-sonnet-4-6", undefined)).toBe("claude-agent-sdk");
  });

  it("forces vercel-ai-sdk for non-Anthropic models regardless of agent runner", () => {
    expect(resolveEffectiveRunner("openai/gpt-4o", "claude-agent-sdk")).toBe("vercel-ai-sdk");
    expect(resolveEffectiveRunner("openai/gpt-4o", null)).toBe("vercel-ai-sdk");
    expect(resolveEffectiveRunner("google/gemini-2.5-pro", "claude-agent-sdk")).toBe("vercel-ai-sdk");
  });
});

describe("isPermissionModeAllowed", () => {
  it("allows all modes for claude-agent-sdk", () => {
    expect(isPermissionModeAllowed("claude-agent-sdk", "default")).toBe(true);
    expect(isPermissionModeAllowed("claude-agent-sdk", "acceptEdits")).toBe(true);
    expect(isPermissionModeAllowed("claude-agent-sdk", "bypassPermissions")).toBe(true);
    expect(isPermissionModeAllowed("claude-agent-sdk", "plan")).toBe(true);
  });

  it("only allows default and bypassPermissions for vercel-ai-sdk", () => {
    expect(isPermissionModeAllowed("vercel-ai-sdk", "default")).toBe(true);
    expect(isPermissionModeAllowed("vercel-ai-sdk", "bypassPermissions")).toBe(true);
    expect(isPermissionModeAllowed("vercel-ai-sdk", "acceptEdits")).toBe(false);
    expect(isPermissionModeAllowed("vercel-ai-sdk", "plan")).toBe(false);
  });
});
