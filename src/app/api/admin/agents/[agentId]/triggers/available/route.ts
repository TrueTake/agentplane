import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/db";
import { AgentRow } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { logger } from "@/lib/logger";
import { listTriggerTypes } from "@/lib/composio-triggers";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string }> };

// GET /api/admin/agents/:agentId/triggers/available — list trigger types for
// every toolkit currently connected on the agent.
export const GET = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) {
    return NextResponse.json({ error: { code: "not_found", message: "Agent not found" } }, { status: 404 });
  }

  const toolkits = agent.composio_toolkits.map((s) => s.toLowerCase());
  if (toolkits.length === 0) {
    return NextResponse.json({ items: [] });
  }

  const results = await Promise.all(
    toolkits.map(async (toolkitSlug) => {
      try {
        return await listTriggerTypes(toolkitSlug);
      } catch (err) {
        logger.warn("triggers/available: listTriggerTypes failed", {
          toolkitSlug,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
    }),
  );

  // Flatten and dedupe by slug (a toolkit should return unique slugs already,
  // but be defensive in case a caller connects overlapping toolkits).
  const seen = new Set<string>();
  const items = results.flat().filter((t) => {
    if (seen.has(t.slug)) return false;
    seen.add(t.slug);
    return true;
  });

  return NextResponse.json({ items });
});
