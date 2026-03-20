import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { queryOne, execute } from "@/db";
import { TenantRow, TimezoneSchema } from "@/lib/validation";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { z } from "zod";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));

  const tenant = await queryOne(
    TenantRow,
    "SELECT * FROM tenants WHERE id = $1",
    [auth.tenantId],
  );

  if (!tenant) throw new NotFoundError("Tenant not found");

  return jsonResponse(tenant);
});

const UpdateTenantSelfSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  timezone: TimezoneSchema.optional(),
  monthly_budget_usd: z.number().min(0).optional(),
  logo_url: z.string().max(100_000).refine(
    (val) => val.startsWith('https://') || val.startsWith('data:image/'),
    'Logo must be an HTTPS URL or data:image/ URI'
  ).nullable().optional(),
});

export const PATCH = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const body = await request.json();
  const input = UpdateTenantSelfSchema.parse(body);

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) {
    sets.push(`name = $${idx++}`);
    params.push(input.name);
  }
  if (input.timezone !== undefined) {
    sets.push(`timezone = $${idx++}`);
    params.push(input.timezone);
  }
  if (input.monthly_budget_usd !== undefined) {
    sets.push(`monthly_budget_usd = $${idx++}`);
    params.push(input.monthly_budget_usd);
  }
  if (input.logo_url !== undefined) {
    sets.push(`logo_url = $${idx++}`);
    params.push(input.logo_url);
  }

  if (sets.length === 0) {
    throw new ValidationError("No fields to update");
  }

  params.push(auth.tenantId);
  await execute(`UPDATE tenants SET ${sets.join(", ")} WHERE id = $${idx}`, params);

  const tenant = await queryOne(
    TenantRow,
    "SELECT * FROM tenants WHERE id = $1",
    [auth.tenantId],
  );

  if (!tenant) throw new NotFoundError("Tenant not found");

  return jsonResponse(tenant);
});
