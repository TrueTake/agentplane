import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { query, queryOne } from "@/db";
import { PluginMarketplacePublicRow, PluginMarketplaceRow, CreatePluginMarketplaceSchema } from "@/lib/validation";
import { NextRequest, NextResponse } from "next/server";
import { ConflictError } from "@/lib/errors";
import { fetchRepoTree } from "@/lib/github";
import { encrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

// GET /api/plugin-marketplaces — list available marketplaces (tenant-scoped)
export const GET = withErrorHandler(async (request: NextRequest) => {
  const { tenantId } = await authenticateApiKey(request.headers.get("authorization"));

  const marketplaces = await query(
    PluginMarketplacePublicRow,
    "SELECT id, name, github_repo, created_at, updated_at FROM plugin_marketplaces WHERE tenant_id = $1 ORDER BY name",
    [tenantId],
  );

  return jsonResponse({ data: marketplaces });
});

// POST /api/plugin-marketplaces — create marketplace (tenant-scoped)
export const POST = withErrorHandler(async (request: NextRequest) => {
  const { tenantId } = await authenticateApiKey(request.headers.get("authorization"));

  const body = await request.json();
  const input = CreatePluginMarketplaceSchema.parse({ ...body, tenant_id: tenantId });

  const existing = await queryOne(
    PluginMarketplaceRow,
    "SELECT * FROM plugin_marketplaces WHERE tenant_id = $1 AND github_repo = $2",
    [tenantId, input.github_repo],
  );
  if (existing) {
    throw new ConflictError(`Marketplace already registered: ${input.github_repo}`);
  }

  const token = input.github_token;
  const [owner, repo] = input.github_repo.split("/");
  const treeResult = await fetchRepoTree(owner, repo, token);
  if (!treeResult.ok) {
    throw new ConflictError(`Cannot access GitHub repo: ${treeResult.message}`);
  }

  let githubTokenEnc: string | null = null;
  if (input.github_token) {
    const env = getEnv();
    const encrypted = await encrypt(input.github_token, env.ENCRYPTION_KEY);
    githubTokenEnc = JSON.stringify(encrypted);
  }

  const marketplace = await queryOne(
    PluginMarketplaceRow,
    `INSERT INTO plugin_marketplaces (tenant_id, name, github_repo, github_token_enc) VALUES ($1, $2, $3, $4) RETURNING *`,
    [tenantId, input.name, input.github_repo, githubTokenEnc],
  );

  return NextResponse.json(marketplace, { status: 201 });
});
