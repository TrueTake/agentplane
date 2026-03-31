# Live NDJSON Streaming for Admin UI - Research Summary

## 1. Admin Run Detail Page (`src/app/admin/(dashboard)/runs/[runId]/page.tsx`)

**Server Component** (RSC, `force-dynamic`). Fetches run via direct DB query (`queryOne` with `RunRow` schema, no RLS -- admin queries bypass tenant scoping). Fetches transcript from `run.transcript_blob_url` (Vercel Blob), parses NDJSON lines into `{ type, ...rest }[]`, passes to `<TranscriptViewer transcript={transcript} prompt={run.prompt} />`.

**Key limitation:** No client-side data fetching, no polling, no streaming. Transcript is fetched once at page load. For running/pending runs, shows `<CancelRunButton>` but no live transcript.

**Component tree:**
- `RunDetailPage` (RSC) -> MetricCards + ErrorCard + `<TranscriptViewer>` (client) + Metadata details

## 2. TranscriptViewer (`src/app/admin/(dashboard)/runs/[runId]/transcript-viewer.tsx`)

**Client component** (`"use client"`). Accepts `transcript: TranscriptEvent[]` as props. Uses `useMemo(() => buildConversation(transcript), [transcript])` to transform raw events into `ConversationItem[]`.

**Can it handle incremental additions?** Yes, with minor changes. `buildConversation()` is a pure function that processes a flat event array. If you pass a growing array, `useMemo` will recompute on each change. The `ConversationView` renders items by array index (`key={i}`), which works for append-only updates. No internal state depends on transcript length.

**Event types handled:** `system`, `assistant` (Claude SDK nested format), `user` (tool_result pairing), `tool_use` (AI SDK flat), `tool_result` (AI SDK flat), `run_started`, `mcp_error`, `result`, `error`, `a2a_incoming`, `mcp_status`, `rate_limit_event`.

**Not handled (streaming-specific):** `text_delta`, `heartbeat`, `stream_detached` -- these are streaming-only events that need filtering or special handling.

## 3. Admin Stream Endpoint (`src/app/api/admin/runs/[runId]/stream/route.ts`)

**Already exists!** This is the key discovery. It's an admin-specific NDJSON stream endpoint.

**Auth:** Goes through middleware's `/api/admin` path -- accepts either `Bearer ADMIN_API_KEY` or admin cookie (HMAC session token). No tenant API key needed.

**Behavior:**
- If run is completed: returns transcript from blob (with `offset` support for deduplication)
- If run is running: reconnects to sandbox via `Sandbox.get()`, polls `transcript.ndjson` file every 2s
- Sends heartbeats every 15s
- Auto-detaches after `maxDuration - 15` seconds (285s) with `stream_detached` event containing `poll_url` and `offset`
- Filters out sandbox heartbeats (sends its own)
- Terminates on `result` or `error` event types

**Query params:** `?offset=N` -- number of lines already received (skip duplicates)

**Max duration:** 300s (5 min)

## 4. Admin Runs List Page (`src/app/admin/(dashboard)/runs/page.tsx`)

**Server Component** (RSC, `force-dynamic`). Direct DB query with `JOIN agents`. Supports pagination and source filtering via search params. **No polling, no client-side refresh.** Entirely server-rendered on each navigation.

## 5. Toast/Notification Infrastructure

**None exists.** No sonner, react-hot-toast, or Radix Toast found in the codebase. The `CancelRunButton` uses `alert()` for errors. This means you'll need to add a toast library if you want stream error/disconnect notifications.

## 6. Auth Flow for Admin Streaming

**Middleware (`src/middleware.ts`):**
- `/admin/*` pages: requires `admin_session` cookie (HMAC-signed, 7-day expiry)
- `/api/admin/*` routes: accepts cookie OR `Bearer ADMIN_API_KEY` header
- Cookie set via `authenticateAdminFromCookie()` which verifies HMAC signature + expiry

**For browser-initiated fetch to `/api/admin/runs/:id/stream`:** The browser automatically sends the `admin_session` cookie, so `adminStream("/runs/:id/stream")` from `src/app/admin/lib/api.ts` will authenticate seamlessly.

## 7. NDJSON Event Types & Shapes

From `streaming.ts` and `transcript-utils.ts`, the event vocabulary:

| Event Type | Source | Shape |
|---|---|---|
| `run_started` | AI SDK runner | `{ type, model, mcp_server_names }` |
| `system` | Claude SDK | `{ type, model, tools, skills }` |
| `assistant` | Claude SDK | `{ type, message: { content: ContentBlock[] } }` |
| `tool_use` | AI SDK | `{ type, tool_name, input, tool_use_id }` |
| `tool_result` | AI SDK | `{ type, tool_use_id, result }` |
| `text_delta` | Both | `{ type, delta }` -- NOT stored in transcript |
| `result` | Both | `{ type, subtype, cost_usd, num_turns, duration_ms, usage, model }` |
| `error` | Both | `{ type, error, code? }` |
| `heartbeat` | Stream layer | `{ type, timestamp }` -- filter out in UI |
| `stream_detached` | Stream layer | `{ type, poll_url, offset, timestamp }` |
| `mcp_error` | Both | `{ type, server, error }` |
| `a2a_incoming` | A2A | `{ type, agent_name, prompt_preview, callback_url }` |
| `mcp_status` | Both | `{ type, ...details }` |
| `rate_limit_event` | Both | `{ type, ...details }` |

## 8. Admin API for Run Detail (`src/app/api/admin/runs/[runId]/route.ts`)

**GET** returns `{ run, transcript }` where transcript is the parsed NDJSON array. Uses `withErrorHandler`. No RLS (admin route). Also available: `/api/admin/runs/[runId]/cancel` (POST).

## Key Client Utility: `adminStream()`

`src/app/admin/lib/api.ts` exports `adminStream(path)` which returns the raw `Response` object for streaming endpoints. This is the correct way to consume the NDJSON stream from client components.

---

## Architecture Recommendations for Implementation

### Approach: Hybrid RSC + Client Streaming Component

1. **Keep `page.tsx` as RSC** for initial data load (run metadata, completed transcript)
2. **Create a new `<LiveRunView>` client component** that:
   - Receives initial run data + transcript as props
   - If `run.status === "running" || run.status === "pending"`:
     - Calls `adminStream(`/runs/${runId}/stream?offset=0`)` on mount
     - Parses NDJSON lines via `ReadableStream` reader
     - Appends events to a `useState<TranscriptEvent[]>` array
     - Passes growing array to existing `<TranscriptViewer>`
     - Handles `stream_detached` by reconnecting with new offset
     - Handles `result`/`error` by refreshing run metadata via `router.refresh()`
   - If run is completed: renders existing static `<TranscriptViewer>`

3. **NDJSON client parser pattern:**
```typescript
const res = await adminStream(`/runs/${runId}/stream?offset=${offset}`);
const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buffer = "";
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop()!; // incomplete line
  for (const line of lines) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type === "heartbeat") continue;
    if (event.type === "stream_detached") { /* reconnect */ }
    setEvents(prev => [...prev, event]);
  }
}
```

4. **Auto-scroll:** Add a ref to the transcript container bottom, scroll on new events
5. **Status badge:** Update in real-time when terminal event received
6. **Metric cards:** Update cost/turns/duration from `result` event data

### No changes needed to:
- `TranscriptViewer` -- it already handles all event types from both runners
- Admin stream endpoint -- already exists with full reconnect support
- Auth -- cookie auth works automatically for browser fetches
- Middleware -- already handles `/api/admin/*` paths

### May want to add:
- Toast library (sonner recommended) for disconnect/error notifications
- Polling on runs list page for status updates (or keep manual refresh)
- `text_delta` rendering in TranscriptViewer for real-time typing effect
