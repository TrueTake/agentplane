/**
 * Model detection and runner routing.
 *
 * The runner is an explicit agent-level choice:
 * - Claude/Anthropic models: user picks runner (Claude Agent SDK default, or Vercel AI SDK)
 * - Non-Claude models: always Vercel AI SDK (auto-set)
 */

export type RunnerType = "claude-agent-sdk" | "vercel-ai-sdk";

/** Returns the default runner for a model (used when agent has no explicit runner set). */
export function defaultRunnerForModel(model: string): RunnerType {
  if (!model.includes("/") || model.startsWith("anthropic/")) {
    return "claude-agent-sdk";
  }
  return "vercel-ai-sdk";
}

/** Returns whether the model supports the Claude Agent SDK runner. */
export function supportsClaudeRunner(model: string): boolean {
  return !model.includes("/") || model.startsWith("anthropic/");
}

/** Resolves the effective runner: agent's explicit choice, or default for model. */
export function resolveEffectiveRunner(
  model: string,
  agentRunner: RunnerType | null | undefined,
): RunnerType {
  if (agentRunner) return agentRunner;
  return defaultRunnerForModel(model);
}

/** Convenience: true when the effective runner is claude-agent-sdk. */
export function isClaudeRunner(
  model: string,
  agentRunner: RunnerType | null | undefined,
): boolean {
  return resolveEffectiveRunner(model, agentRunner) === "claude-agent-sdk";
}

/**
 * Context window sizes (in tokens) for known models.
 * Used by session history truncation (Phase 3).
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "openai/gpt-4o": 128_000,
  "openai/gpt-4o-mini": 128_000,
  "openai/o3": 200_000,
  "google/gemini-2.5-pro": 1_000_000,
  "google/gemini-2.5-flash": 1_000_000,
  "mistral/mistral-large": 128_000,
  "xai/grok-3": 131_072,
  "deepseek/deepseek-chat": 128_000,
};

/** Conservative default for unknown models (fail closed). */
export const DEFAULT_CONTEXT_WINDOW = 16_000;
