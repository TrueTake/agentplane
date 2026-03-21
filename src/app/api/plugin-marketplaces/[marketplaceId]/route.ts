import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { queryOne, execute } from "@/db";
import { PluginMarketplaceRow, UpdateMarketplaceSchema } from "@/lib/validation";
import { NotFoundError, ConflictError, ForbiddenError } from "@/lib/errors";
import { clearPluginCache } from "@/lib/plugins";
import { checkWriteAccess } from "@/lib/github";
import { encrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { z } from "zod";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ marketplaceId: string }> };

// GET /api/plugin-marketplaces/:id — get single marketplace (tenant-scoped)
export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const { tenantId } = await authenticateApiKey(request.headers.get("authorization"));
  const { marketplaceId } = await (context as RouteContext).params;

  const marketplace = await queryOne(
    PluginMarketplaceRow,
    "SELECT * FROM plugin_marketplaces WHERE id = $1 AND tenant_id = $2",
    [marketplaceId, tenantId],
  );
  if (!marketplace) throw new NotFoundError("Plugin marketplace not found");

  return jsonResponse({
    ...marketplace,
    github_token_enc: undefined,
    has_token: marketplace.github_token_enc !== null,
  });
});

// PATCH /api/plugin-marketplaces/:id — update token (tenant-scoped)
export const PATCH = withErrorHandler(async (request: NextRequest, context) => {
  const { tenantId } = await authenticateApiKey(request.headers.get("authorization"));
  const { marketplaceId } = await (context as RouteContext).params;

  const marketplace = await queryOne(
    PluginMarketplaceRow,
    "SELECT * FROM plugin_marketplaces WHERE id = $1 AND tenant_id = $2",
    [marketplaceId, tenantId],
  );
  if (!marketplace) throw new NotFoundError("Plugin marketplace not found");

  const body = await request.json();
  const input = UpdateMarketplaceSchema.parse(body);

  if (input.github_token !== undefined) {
    if (input.github_token === null) {
      await execute(
        "UPDATE plugin_marketplaces SET github_token_enc = NULL WHERE id = $1",
        [marketplaceId],
      );
    } else {
      const [owner, repo] = marketplace.github_repo.split("/");
      const accessResult = await checkWriteAccess(owner, repo, input.github_token);
      if (!accessResult.ok) {
        throw new ForbiddenError(`Token validation failed: ${accessResult.message}`);
      }

      const env = getEnv();
      const encrypted = await encrypt(input.github_token, env.ENCRYPTION_KEY);
      await execute(
        "UPDATE plugin_marketplaces SET github_token_enc = $1 WHERE id = $2",
        [JSON.stringify(encrypted), marketplaceId],
      );
    }
  }

  const updated = await queryOne(
    PluginMarketplaceRow,
    "SELECT * FROM plugin_marketplaces WHERE id = $1",
    [marketplaceId],
  );

  return jsonResponse({
    ...updated,
    github_token_enc: undefined,
    has_token: updated!.github_token_enc !== null,
  });
});

const AgentRefCount = z.object({ count: z.coerce.number() });

// DELETE /api/plugin-marketplaces/:id (tenant-scoped)
export const DELETE = withErrorHandler(async (request: NextRequest, context) => {
  const { tenantId } = await authenticateApiKey(request.headers.get("authorization"));
  const { marketplaceId } = await (context as RouteContext).params;

  const existing = await queryOne(
    PluginMarketplaceRow,
    "SELECT * FROM plugin_marketplaces WHERE id = $1 AND tenant_id = $2",
    [marketplaceId, tenantId],
  );
  if (!existing) throw new NotFoundError("Plugin marketplace not found");

  const refCount = await queryOne(
    AgentRefCount,
    `SELECT COUNT(*)::int AS count FROM agents WHERE tenant_id = $1 AND plugins @> $2::jsonb`,
    [tenantId, JSON.stringify([{ marketplace_id: marketplaceId }])],
  );

  if (refCount && refCount.count > 0) {
    throw new ConflictError(
      `Cannot delete marketplace: ${refCount.count} agent(s) use plugins from it. Remove plugins from agents first.`,
    );
  }

  const { rowCount } = await execute(
    "DELETE FROM plugin_marketplaces WHERE id = $1 AND tenant_id = $2",
    [marketplaceId, tenantId],
  );
  if (rowCount === 0) throw new NotFoundError("Plugin marketplace not found");

  clearPluginCache();

  return jsonResponse({ deleted: true });
});
