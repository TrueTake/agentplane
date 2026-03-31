---
date: 2026-03-30
topic: a2a-multi-turn-sandbox-reuse
---

# A2A Multi-Turn Sandbox Reuse

## Problem Frame

When AgentPlane receives multiple A2A messages with the same `contextId` (e.g., a Discord conversation thread), each message currently creates a fresh sandbox. The agent loses all conversation memory, tool state, file system changes, and MCP connections between turns. This makes multi-turn conversations unnatural (agent must re-read history via tools), slow (sandbox cold-start per message), and expensive (new sandbox per turn).

AgentPlane already has session infrastructure (`sessions` table with `sandbox_id`, `status`, idle tracking) and `reconnectSandbox()` — but this is only used by the Chat/Session flow, not by A2A.

## Requirements

- R1. When an A2A `message/send` includes a `contextId` that matches an existing active/idle session, reuse that session's sandbox instead of creating a new one.
- R2. When no matching session exists for a `contextId`, create a new session and sandbox. Store the `contextId` on the session so future messages can find it.
- R3. Each A2A message within a session creates a new run in the `runs` table, linked to the session via `session_id`. The run lifecycle (pending → running → completed) works the same as today.
- R4. The reused sandbox must receive the new message as a continuation of the existing conversation — the agent should see it as the next turn, not a fresh invocation.
- R5. Session idle timeout and cleanup continue to work — idle sessions have their sandboxes stopped by the existing cleanup cron.
- R6. Concurrent messages to the same session must be serialized or rejected — two messages cannot execute simultaneously in the same sandbox.
- R7. If sandbox reconnection fails (sandbox was stopped/cleaned up), fall back to creating a fresh sandbox transparently.
- R8. Preserve client-supplied `contextId` in A2A responses (currently overwritten with `run.id`).

## Success Criteria

- An agent responding to Discord messages in the same chat thread maintains conversation memory across turns without re-reading history via tools
- Agent's file system, variables, and MCP connections persist across turns within the same session
- Second message in a conversation responds faster than the first (warm sandbox, no cold-start)
- No duplicate runs — each A2A message produces exactly one run
- Existing A2A flow (no contextId, or first message with new contextId) works identically to today

## Scope Boundaries

- **Not changing**: The Chat/Session executor flow — that stays as-is for the web UI
- **Not changing**: `prepareRunExecution()` — it always creates a new sandbox, which is correct for first-time runs
- **Not building**: Cross-agent session sharing — sessions are scoped to one agent
- **Not building**: Session transfer or migration between sandboxes
- **A2A only**: This does not affect web UI sessions, scheduled runs, or admin-triggered runs

## Key Decisions

- **Stay in the A2A execution path**: The failed first attempt delegated to `executeSessionMessage()` (Chat/Session executor), which created a duplicate run with source "Chat". The correct approach is to modify the A2A executor to optionally reconnect to an existing sandbox, keeping all run creation and event publishing in the A2A path.
- **One run per A2A message, always**: Even when reusing a session/sandbox, each A2A message creates its own run. The run is linked to the session via `session_id`.
- **Idle-to-active transition as concurrency lock**: When reusing a session, atomically transition it from `idle` to `active`. If the transition fails (session not idle), the message should wait or reject — not create a duplicate session.

## Dependencies / Assumptions

- `sessions` table already has `sandbox_id`, `status`, `last_message_at`, `idle_since` columns
- `runs.session_id` FK already exists
- `reconnectSandbox()` in `sandbox.ts` works for reconnecting to Vercel Sandboxes
- The Claude Agent SDK in the sandbox supports receiving additional messages in an existing session (need to verify how the runner script handles this)

## Key Technical Direction

This brainstorm is inherently technical, so including the high-level approach:

**Mechanism:** AgentPlane's session executor already supports multi-turn via a file-based protocol:
1. `reconnectSessionSandbox()` reconnects to an existing Vercel Sandbox
2. `sandbox.runMessage()` writes a new runner script (with the new prompt) to the sandbox filesystem
3. The runner script loads session history from `/vercel/sandbox/session-history.json`, appends the new message, runs Claude, and saves updated history
4. Each turn is a fresh Node.js process in the same sandbox — no long-lived server needed

**Approach for A2A:** Use `reconnectSessionSandbox()` + `sandbox.runMessage()` directly in the A2A executor (not `executeSessionMessage()`, which creates duplicate "Chat" runs). The A2A executor handles its own run creation, event publishing, and finalization — it just needs to optionally use an existing sandbox instead of always creating a new one.

## Outstanding Questions

### Deferred to Planning
- [Affects R6][Technical] Concurrency handling: if a second message arrives while the first is still executing, should it queue (wait for idle), reject (return error), or create a fresh session?
- [Affects R5][Technical] Should A2A sessions have a different idle timeout than Chat sessions? Discord conversations may have longer gaps between messages.
- [Affects R2][Technical] Schema change needed: add `context_id` column to sessions table with unique partial index for lookup.
- [Affects R4][Technical] How to handle callback data (MCP tools from AgentCo) on session reuse — should it update the sandbox's MCP config on each turn, or only on first?

## Next Steps

→ `/ce:plan` for structured implementation planning
