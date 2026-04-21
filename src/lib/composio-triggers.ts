// Thin, error-sanitized wrapper around @composio/core's `triggers.*` surface.
//
// Keeps all new webhook-trigger code on @composio/core (which documents the
// triggers surface directly) while the existing MCP/toolkits/auth code in
// src/lib/composio.ts continues to use @composio/client. This is the single
// abstraction point for the new SDK; SDK drift is a one-file change.

import { Composio } from "@composio/core";
import { logger } from "./logger";

let _client: Composio | null = null;
let _testOverride = false;

function getComposioCoreClient(): Composio | null {
  if (_testOverride) return _client;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    logger.warn("COMPOSIO_API_KEY not set; composio-triggers operations will no-op");
    return null;
  }
  if (!_client) {
    _client = new Composio({ apiKey });
  }
  return _client;
}

// Test seam: let tests inject a mocked client without touching process.env.
// Passing null + calling this a second time with a real client path not needed —
// tests reset via the afterEach hook.
export function __setComposioCoreClientForTests(client: Composio | null): void {
  _client = client;
  _testOverride = client !== null;
}

export interface ListedTriggerType {
  slug: string;
  name: string;
  description: string;
  instructions?: string;
  toolkit: { slug: string; name: string; logo: string };
}

export interface CreateTriggerInput {
  /** Tenant id; Composio treats this as the `user_id` scoping value. */
  userId: string;
  /** Trigger type slug, e.g. `LINEAR_ISSUE_CREATED`. */
  triggerType: string;
  /** Connected-account id bound to the toolkit for this tenant. */
  connectedAccountId?: string;
  /** Provider-specific subscribe-time config (not the AgentPlane-side filter). */
  config?: Record<string, unknown>;
}

export interface ActiveTrigger {
  id: string;
  state: "enabled" | "disabled" | "unknown";
  triggerName: string | null;
  connectedAccountId: string | null;
}

/** Sanitize raw Composio errors to tenant-safe messages. Mirrors sanitizeComposioError in composio.ts. */
export function sanitizeComposioTriggersError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not found/i.test(msg)) return "Composio trigger type not found";
  if (/invalid/i.test(msg)) return "Invalid trigger configuration";
  if (/unauthori[sz]ed|forbidden/i.test(msg)) return "Composio authorization failed";
  if (/timeout/i.test(msg)) return "Composio upstream timeout";
  return "Composio upstream error — please try again";
}

function isNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const statusLike = (err as { status?: number; statusCode?: number } | null)?.status
    ?? (err as { status?: number; statusCode?: number } | null)?.statusCode;
  return statusLike === 404 || /not found|404/i.test(msg);
}

export async function listTriggerTypes(toolkitSlug: string): Promise<ListedTriggerType[]> {
  const client = getComposioCoreClient();
  if (!client) return [];
  try {
    const res = await client.triggers.listTypes({ toolkits: [toolkitSlug.toLowerCase()] });
    return res.items.map((it) => ({
      slug: it.slug,
      name: it.name,
      description: it.description,
      instructions: it.instructions,
      toolkit: { slug: it.toolkit.slug, name: it.toolkit.name, logo: it.toolkit.logo },
    }));
  } catch (err) {
    logger.error("composio-triggers.listTypes failed", {
      toolkit: toolkitSlug,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(sanitizeComposioTriggersError(err));
  }
}

export async function createTrigger(
  input: CreateTriggerInput,
): Promise<{ composioTriggerId: string }> {
  const client = getComposioCoreClient();
  if (!client) throw new Error("COMPOSIO_API_KEY not configured");
  try {
    const res = await client.triggers.create(input.userId, input.triggerType, {
      connectedAccountId: input.connectedAccountId,
      triggerConfig: input.config,
    });
    return { composioTriggerId: res.triggerId };
  } catch (err) {
    logger.error("composio-triggers.create failed", {
      triggerType: input.triggerType,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(sanitizeComposioTriggersError(err));
  }
}

export async function enableTrigger(composioTriggerId: string): Promise<void> {
  const client = getComposioCoreClient();
  if (!client) throw new Error("COMPOSIO_API_KEY not configured");
  try {
    await client.triggers.enable(composioTriggerId);
  } catch (err) {
    logger.error("composio-triggers.enable failed", {
      triggerId: composioTriggerId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(sanitizeComposioTriggersError(err));
  }
}

export async function disableTrigger(composioTriggerId: string): Promise<void> {
  const client = getComposioCoreClient();
  if (!client) throw new Error("COMPOSIO_API_KEY not configured");
  try {
    await client.triggers.disable(composioTriggerId);
  } catch (err) {
    logger.error("composio-triggers.disable failed", {
      triggerId: composioTriggerId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(sanitizeComposioTriggersError(err));
  }
}

/**
 * Delete a trigger subscription. Returns `{ alreadyGone: true }` for 404
 * so callers (notably the cascade-cancel cron) can treat external-already-deleted
 * as a success path without exception handling.
 */
export async function deleteTrigger(
  composioTriggerId: string,
): Promise<{ alreadyGone: boolean }> {
  const client = getComposioCoreClient();
  if (!client) throw new Error("COMPOSIO_API_KEY not configured");
  try {
    await client.triggers.delete(composioTriggerId);
    return { alreadyGone: false };
  } catch (err) {
    if (isNotFoundError(err)) {
      logger.info("composio-triggers.delete: already gone", { triggerId: composioTriggerId });
      return { alreadyGone: true };
    }
    logger.error("composio-triggers.delete failed", {
      triggerId: composioTriggerId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(sanitizeComposioTriggersError(err));
  }
}

/** Retrieve a single active trigger instance. Returns null if not found. */
export async function getTrigger(composioTriggerId: string): Promise<ActiveTrigger | null> {
  const client = getComposioCoreClient();
  if (!client) return null;
  try {
    const res = await client.triggers.listActive({
      triggerIds: [composioTriggerId],
      showDisabled: true,
      limit: 1,
    });
    const item = res.items[0];
    if (!item) return null;
    // SDK's state field shape varies by version; coerce to our 3-value union.
    const raw = (item as { state?: unknown }).state;
    const state: ActiveTrigger["state"] =
      raw === "enabled" || raw === "disabled" ? raw : "unknown";
    return {
      id: (item as { id: string }).id,
      state,
      triggerName: (item as { triggerName?: string }).triggerName ?? null,
      connectedAccountId: (item as { connectedAccountId?: string }).connectedAccountId ?? null,
    };
  } catch (err) {
    if (isNotFoundError(err)) return null;
    logger.error("composio-triggers.getTrigger failed", {
      triggerId: composioTriggerId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(sanitizeComposioTriggersError(err));
  }
}
