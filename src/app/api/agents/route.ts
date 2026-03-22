import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { CreateAgentSchema, AgentRow, PaginationSchema } from "@/lib/validation";
import { query, execute } from "@/db";
import { generateId } from "@/lib/crypto";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const body = await request.json();
  const input = CreateAgentSchema.parse(body);
  const id = generateId();

  const rawSlug = slugifyName(input.name) || `agent-${id.slice(0, 8)}`;

  // Retry with suffix on duplicate name or slug
  let name = input.name;
  let slug = rawSlug;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await execute(
        `INSERT INTO agents (id, tenant_id, name, slug, description, git_repo_url, git_branch,
          composio_toolkits, skills, model, runner, allowed_tools, permission_mode, max_turns, max_budget_usd, max_runtime_seconds, a2a_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          id,
          auth.tenantId,
          name,
          slug,
          input.description ?? null,
          input.git_repo_url ?? null,
          input.git_branch,
          input.composio_toolkits,
          JSON.stringify(input.skills),
          input.model,
          input.runner,
          input.allowed_tools,
          input.permission_mode,
          input.max_turns,
          input.max_budget_usd,
          input.max_runtime_seconds,
          input.a2a_enabled,
        ],
      );
      break;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("agents_tenant_id_name_key") && attempt < 4) {
        name = `${input.name}-${attempt + 2}`;
        slug = `${rawSlug}-${attempt + 2}`;
        continue;
      }
      throw err;
    }
  }

  const agent = await query(
    AgentRow,
    "SELECT * FROM agents WHERE id = $1 AND tenant_id = $2",
    [id, auth.tenantId],
  );

  logger.info("Agent created", { tenant_id: auth.tenantId, agent_id: id, name });

  return jsonResponse(agent[0], 201);
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const url = new URL(request.url);
  const pagination = PaginationSchema.parse({
    limit: url.searchParams.get("limit"),
    offset: url.searchParams.get("offset"),
  });

  const agents = await query(
    AgentRow,
    `SELECT * FROM agents WHERE tenant_id = $1
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [auth.tenantId, pagination.limit, pagination.offset],
  );

  return jsonResponse({ data: agents, limit: pagination.limit, offset: pagination.offset });
});
