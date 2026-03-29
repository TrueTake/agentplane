"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useAgentPlaneClient } from "../../hooks/use-client";
import { useNavigation } from "../../hooks/use-navigation";
import { useApi } from "../../hooks/use-api";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Skeleton } from "../ui/skeleton";
import { MetricCard } from "../ui/metric-card";
import { TranscriptViewer } from "./transcript-viewer";
import type { PlaygroundStream, PlaygroundStreamEvent } from "../../types";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface PlaygroundEvent {
  type: string;
  [key: string]: unknown;
}

interface AgentData {
  id: string;
  name: string;
  model: string;
  description: string | null;
}

export interface PlaygroundPageProps {
  agentId: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function PlaygroundPage({ agentId }: PlaygroundPageProps) {
  const client = useAgentPlaneClient();
  const { LinkComponent, basePath } = useNavigation();

  const { data: agent, error: agentError, isLoading } = useApi<AgentData>(
    `agent-${agentId}`,
    (c) => c.agents.get(agentId) as Promise<AgentData>,
  );

  const [prompt, setPrompt] = useState("");
  const [events, setEvents] = useState<PlaygroundEvent[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [running, setRunning] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | null>(null);
  const streamRef = useRef<PlaygroundStream | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      streamRef.current?.abort();
    };
  }, []);

  const resultEvent = useMemo(
    () => [...events].reverse().find((ev) => ev.type === "result"),
    [events],
  );

  const pollForFinalResult = useCallback(async (runId: string) => {
    setPolling(true);
    let delay = 3000;
    const maxDelay = 10_000;

    try {
      while (true) {
        if (abortRef.current?.signal.aborted) break;

        await new Promise((r) => setTimeout(r, delay));
        if (abortRef.current?.signal.aborted) break;

        try {
          const run = await client.runs.get(runId) as { status: string; cost_usd?: number; num_turns?: number; duration_ms?: number; error_type?: string };

          if (TERMINAL_STATUSES.has(run.status)) {
            // Try to get transcript for events after detach
            try {
              const transcriptEvents = await client.runs.transcriptArray(runId) as PlaygroundEvent[];
              if (transcriptEvents.length > 0) {
                const detachIdx = transcriptEvents.findIndex((ev) => ev.type === "stream_detached");
                const eventsAfterDetach = detachIdx >= 0 ? transcriptEvents.slice(detachIdx + 1) : [];
                const newEvents = eventsAfterDetach.filter(
                  (ev: PlaygroundEvent) =>
                    ev.type !== "heartbeat" &&
                    ev.type !== "text_delta" &&
                    ev.type !== "run_started" &&
                    ev.type !== "queued" &&
                    ev.type !== "sandbox_starting"
                );
                if (newEvents.length > 0) {
                  setEvents((prev) => [...prev, ...newEvents]);
                }
              }
            } catch {
              // Transcript fetch is best-effort
            }

            setEvents((prev) => {
              if (prev.some((ev) => ev.type === "result")) return prev;
              const syntheticResult: PlaygroundEvent = {
                type: "result",
                subtype: run.status === "completed" ? "success" : "failed",
                cost_usd: run.cost_usd,
                num_turns: run.num_turns,
                duration_ms: run.duration_ms,
              };
              if (run.error_type) {
                syntheticResult.result = run.error_type;
              }
              return [...prev, syntheticResult];
            });
            break;
          }

          delay = Math.min(delay * 2, maxDelay);
        } catch (err) {
          if ((err as Error)?.name === "AbortError") break;
          delay = Math.min(delay * 2, maxDelay);
        }
      }
    } finally {
      setPolling(false);
      setRunning(false);
      abortRef.current = null;
      runIdRef.current = null;
      streamRef.current = null;
    }
  }, [client]);

  const consumeStream = useCallback(async (stream: PlaygroundStream) => {
    streamRef.current = stream;
    let handedOffToPoll = false;

    try {
      for await (const event of stream) {
        const ev = event as PlaygroundStreamEvent & PlaygroundEvent;

        // Capture session ID
        if (ev.type === "session_created" && ev.session_id) {
          const sid = ev.session_id as string;
          sessionIdRef.current = sid;
          setSessionId(sid);
        }

        // Capture run ID
        if (ev.type === "run_started" && ev.run_id) {
          runIdRef.current = ev.run_id as string;
        }

        if (ev.type === "text_delta") {
          setStreamingText((prev) => prev + (ev.text as string ?? ""));
        } else if (ev.type === "stream_detached") {
          setStreamingText("");
          setEvents((prev) => [...prev, ev]);
          if (runIdRef.current) {
            handedOffToPoll = true;
            pollForFinalResult(runIdRef.current);
            return;
          }
        } else {
          if (ev.type === "assistant") setStreamingText("");
          setEvents((prev) => [...prev, ev]);
        }
      }
    } finally {
      if (!handedOffToPoll) {
        setRunning(false);
        abortRef.current = null;
        runIdRef.current = null;
        streamRef.current = null;
      }
    }
  }, [pollForFinalResult]);

  const handleSend = useCallback(async () => {
    if (!prompt.trim() || running) return;

    const messageText = prompt.trim();
    setPrompt("");
    setRunning(true);
    setStreamingText("");
    setError(null);
    setPolling(false);

    setEvents((prev) => [...prev, { type: "user_message", text: messageText }]);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      let stream: PlaygroundStream;

      const currentSessionId = sessionIdRef.current;
      if (currentSessionId) {
        stream = await client.sessions.sendMessage(
          currentSessionId,
          { prompt: messageText },
          { signal: abort.signal },
        ) as PlaygroundStream;
      } else {
        stream = await client.sessions.create(
          { agent_id: agentId, prompt: messageText },
          { signal: abort.signal },
        ) as PlaygroundStream;
      }

      await consumeStream(stream);
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        const msg = err instanceof Error ? err.message : "Unknown error";
        setError(msg);
      }
      setRunning(false);
      abortRef.current = null;
      runIdRef.current = null;
      streamRef.current = null;
    }
  }, [prompt, running, agentId, client, consumeStream]);

  function handleNewChat() {
    abortRef.current?.abort();
    streamRef.current?.abort();
    if (sessionId) {
      client.sessions.stop(sessionId).catch(() => {});
    }
    sessionIdRef.current = null;
    setSessionId(null);
    setEvents([]);
    setStreamingText("");
    setRunning(false);
    setPolling(false);
    setError(null);
    setPrompt("");
    runIdRef.current = null;
    abortRef.current = null;
    streamRef.current = null;
    textareaRef.current?.focus();
  }

  function handleStop() {
    abortRef.current?.abort();
    streamRef.current?.abort();
    const id = runIdRef.current;
    if (id) {
      runIdRef.current = null;
      client.runs.cancel(id).catch(() => {});
    }
  }

  // --- Loading / Error states ---

  if (isLoading) {
    return (
      <div className="flex flex-col h-[calc(100vh-6rem)]">
        <div className="flex items-center gap-3 mb-4">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="flex-1 rounded-lg" />
        <div className="mt-4 space-y-2">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-8 w-20" />
        </div>
      </div>
    );
  }

  if (agentError || !agent) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-6rem)] gap-3">
        <p className="text-destructive text-sm">
          {agentError?.status === 404
            ? "Agent not found."
            : `Failed to load agent: ${agentError?.message ?? "Unknown error"}`}
        </p>
        <LinkComponent
          href={`${basePath}/agents`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          &larr; Back to agents
        </LinkComponent>
      </div>
    );
  }

  // --- Main render ---

  const hasContent = events.length > 0 || running;

  return (
    <div className="flex flex-col h-[calc(100vh-6rem)]">
      <div className="flex items-center gap-3 mb-4">
        <LinkComponent
          href={`${basePath}/agents/${agentId}`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          &larr; {agent.name}
        </LinkComponent>
        {(sessionId || events.length > 0) && (
          <Button onClick={handleNewChat} variant="outline" size="sm" disabled={running}>
            New Chat
          </Button>
        )}
        {sessionId && (
          <span className="text-xs text-muted-foreground font-mono">
            Session: {sessionId.slice(0, 12)}…
          </span>
        )}
      </div>

      {/* Metrics (when result is available) */}
      {resultEvent && (
        <div className="grid grid-cols-3 gap-4 mb-4 shrink-0">
          <MetricCard label="Cost">
            <span className="font-mono">
              ${(() => {
                const cost = resultEvent.cost_usd ?? resultEvent.total_cost_usd;
                return cost != null ? Number(cost).toFixed(4) : "\u2014";
              })()}
            </span>
          </MetricCard>
          <MetricCard label="Turns">
            {resultEvent.num_turns != null ? String(resultEvent.num_turns) : "\u2014"}
          </MetricCard>
          <MetricCard label="Duration">
            {resultEvent.duration_ms != null
              ? `${(Number(resultEvent.duration_ms) / 1000).toFixed(1)}s`
              : "\u2014"}
          </MetricCard>
        </div>
      )}

      {/* Transcript */}
      {hasContent && (
        <TranscriptViewer
          transcript={events}
          isStreaming={running}
          className="flex-1 min-h-0 mb-4"
        />
      )}

      {/* Streaming text accumulator */}
      {running && streamingText && (
        <div className="rounded-lg border bg-muted/30 p-4 mb-4 shrink-0">
          <pre className="whitespace-pre-wrap text-sm font-mono">
            {streamingText}
            <span className="inline-block w-2 h-4 ml-0.5 bg-foreground/70 animate-pulse align-text-bottom" />
          </pre>
        </div>
      )}

      {/* Input area */}
      <div className="space-y-2 shrink-0">
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Textarea
          ref={textareaRef}
          placeholder={sessionId ? "Send a follow-up message…" : "Enter your prompt…"}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={hasContent ? 3 : 12}
          disabled={running}
          className="font-mono text-sm resize-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend();
          }}
        />
        <div className="flex items-center gap-2">
          <Button onClick={handleSend} disabled={running || !prompt.trim()} size="sm">
            {running ? "Running…" : sessionId ? "Send" : "Run"}
          </Button>
          {running && (
            <Button onClick={handleStop} variant="outline" size="sm">
              Stop
            </Button>
          )}
          <span className="text-xs text-muted-foreground ml-1">⌘+Enter to send</span>
        </div>
      </div>
    </div>
  );
}
