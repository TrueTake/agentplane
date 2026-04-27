import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { NotFoundError } from "@/lib/errors";
import {
  UpdateWebhookSourceSchema,
  deleteWebhookSource,
  getWebhookSource,
  updateWebhookSource,
} from "@/lib/webhooks";
import type { WebhookSourceId } from "@/lib/types";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
  async (request: NextRequest, context) => {
    const auth = await authenticateApiKey(request.headers.get("authorization"));
    const { id } = await context!.params;
    const source = await getWebhookSource(auth.tenantId, id as WebhookSourceId);
    if (!source) throw new NotFoundError("Webhook source not found");
    return jsonResponse(source);
  },
);

export const PATCH = withErrorHandler(
  async (request: NextRequest, context) => {
    const auth = await authenticateApiKey(request.headers.get("authorization"));
    const { id } = await context!.params;
    const body = await request.json();
    const patch = UpdateWebhookSourceSchema.parse(body);
    const source = await updateWebhookSource(auth.tenantId, id as WebhookSourceId, patch);
    if (!source) throw new NotFoundError("Webhook source not found");
    return jsonResponse(source);
  },
);

export const DELETE = withErrorHandler(
  async (request: NextRequest, context) => {
    const auth = await authenticateApiKey(request.headers.get("authorization"));
    const { id } = await context!.params;
    const removed = await deleteWebhookSource(auth.tenantId, id as WebhookSourceId);
    if (!removed) throw new NotFoundError("Webhook source not found");
    return jsonResponse({ deleted: true });
  },
);
