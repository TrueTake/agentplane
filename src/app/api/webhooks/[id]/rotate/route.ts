import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { NotFoundError } from "@/lib/errors";
import { getWebhookSource, rotateSecret } from "@/lib/webhooks";
import type { WebhookSourceId } from "@/lib/types";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(
  async (request: NextRequest, context) => {
    const auth = await authenticateApiKey(request.headers.get("authorization"));
    const { id } = await context!.params;

    const existing = await getWebhookSource(auth.tenantId, id as WebhookSourceId);
    if (!existing) throw new NotFoundError("Webhook source not found");

    const { secret, previousExpiresAt } = await rotateSecret({
      tenantId: auth.tenantId,
      sourceId: id as WebhookSourceId,
    });

    return jsonResponse({
      secret,
      previous_secret_expires_at: previousExpiresAt.toISOString(),
    });
  },
);
