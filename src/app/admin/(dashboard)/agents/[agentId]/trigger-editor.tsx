"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/form-field";
import { FormError } from "@/components/ui/form-error";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { adminFetch, AdminApiError } from "@/app/admin/lib/api";
import type { WebhookTrigger } from "@/lib/webhook-triggers";
import type { WebhookTriggerToolEntry } from "@/lib/types";

interface AvailableTrigger {
  slug: string;
  name: string;
  description: string;
  instructions?: string;
  toolkit: { slug: string; name: string; logo: string };
}

interface AvailableResponse {
  items: AvailableTrigger[];
}

interface TriggerEditorProps {
  agentId: string;
  availableToolkits: string[];
  isPlanMode: boolean;
  // When present, editor runs in "edit" mode; omit for "create" mode.
  initial?: WebhookTrigger;
  onSaved: () => Promise<void> | void;
  onCancel: () => void;
}

// TODO (plan R10 — future work): replace the textarea-based tool allowlist
// input with a live MCP-tool picker that enumerates via resolveAllowedTools.
// For v1 we accept raw tool names (one per line) and synthesize the dual-form
// entry via { claude, aiSdk } — the route's Zod schema accepts both strings
// verbatim. See docs/plans/2026-04-21-001-feat-webhook-triggered-agent-runs-plan.md
// (Unit 10 — tool-allowlist section) for the intended design.
function serializeAllowlist(entries: WebhookTriggerToolEntry[]): string {
  return entries.map((e) => e.claude).join("\n");
}

function parseAllowlist(text: string): WebhookTriggerToolEntry[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((name) => ({ claude: name, aiSdk: name }));
}

export function TriggerEditor({
  agentId,
  availableToolkits,
  isPlanMode,
  initial,
  onSaved,
  onCancel,
}: TriggerEditorProps) {
  const isEdit = Boolean(initial);

  const [toolkitSlug, setToolkitSlug] = useState<string>(
    initial?.toolkit_slug ?? availableToolkits[0] ?? "",
  );
  const [triggerType, setTriggerType] = useState<string>(initial?.trigger_type ?? "");
  const [filterPredicateText, setFilterPredicateText] = useState<string>(
    initial?.filter_predicate ? JSON.stringify(initial.filter_predicate, null, 2) : "",
  );
  const [promptTemplate, setPromptTemplate] = useState<string>(initial?.prompt_template ?? "");
  const [triggerConfigText, setTriggerConfigText] = useState<string>("");
  const [triggerConfigError, setTriggerConfigError] = useState<string | null>(null);
  const [allowlistText, setAllowlistText] = useState<string>(
    initial?.tool_allowlist ? serializeAllowlist(initial.tool_allowlist) : "",
  );
  const [enabled, setEnabled] = useState<boolean>(initial?.enabled ?? false);

  const [available, setAvailable] = useState<AvailableTrigger[]>([]);
  const [availableLoading, setAvailableLoading] = useState(false);
  const [availableError, setAvailableError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [showZeroToolConfirm, setShowZeroToolConfirm] = useState(false);

  // Load available trigger types once (endpoint returns all toolkits the agent
  // is connected to — we filter client-side by the selected toolkit).
  useEffect(() => {
    let cancelled = false;
    setAvailableLoading(true);
    setAvailableError(null);
    adminFetch<AvailableResponse>(`/agents/${agentId}/triggers/available`)
      .then((resp) => {
        if (!cancelled) setAvailable(resp.items ?? []);
      })
      .catch((err) => {
        if (!cancelled) {
          setAvailableError(err instanceof Error ? err.message : "Failed to load trigger types");
        }
      })
      .finally(() => {
        if (!cancelled) setAvailableLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const filteredTriggers = useMemo(
    () => available.filter((t) => t.toolkit.slug.toLowerCase() === toolkitSlug.toLowerCase()),
    [available, toolkitSlug],
  );

  const allowlist = useMemo(() => parseAllowlist(allowlistText), [allowlistText]);

  function validateJsonObject(
    raw: string,
    setErr: (m: string | null) => void,
    label: string,
  ): { ok: boolean; value: Record<string, unknown> | null } {
    const trimmed = raw.trim();
    if (!trimmed) {
      setErr(null);
      return { ok: true, value: null };
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        setErr(`${label} must be a JSON object`);
        return { ok: false, value: null };
      }
      setErr(null);
      return { ok: true, value: parsed as Record<string, unknown> };
    } catch (err) {
      setErr(err instanceof Error ? `Invalid JSON: ${err.message}` : "Invalid JSON");
      return { ok: false, value: null };
    }
  }

  function validateFilter() {
    return validateJsonObject(filterPredicateText, setFilterError, "Filter predicate");
  }

  function validateTriggerConfig() {
    return validateJsonObject(triggerConfigText, setTriggerConfigError, "Trigger config");
  }

  const submit = useCallback(
    async (confirmZeroTools: boolean) => {
      setSaving(true);
      setError(null);
      try {
        const filter = validateFilter();
        if (!filter.ok) {
          setSaving(false);
          return;
        }
        const triggerCfg = validateTriggerConfig();
        if (!triggerCfg.ok) {
          setSaving(false);
          return;
        }

        if (isEdit && initial) {
          const patchBody: Record<string, unknown> = {
            promptTemplate,
            filterPredicate: filter.value,
            toolAllowlist: allowlist,
            enabled,
          };
          await adminFetch(`/agents/${agentId}/triggers/${initial.id}`, {
            method: "PATCH",
            body: JSON.stringify(patchBody),
          });
        } else {
          if (!toolkitSlug) {
            setError("Select a toolkit");
            setSaving(false);
            return;
          }
          if (!triggerType) {
            setError("Select a trigger type");
            setSaving(false);
            return;
          }
          const createBody: Record<string, unknown> = {
            toolkitSlug,
            triggerType,
            promptTemplate,
            filterPredicate: filter.value,
            triggerConfig: triggerCfg.value,
            toolAllowlist: allowlist,
            enabled,
            ...(confirmZeroTools ? { confirmZeroTools: true } : {}),
          };
          await adminFetch(`/agents/${agentId}/triggers`, {
            method: "POST",
            body: JSON.stringify(createBody),
          });
        }

        setShowZeroToolConfirm(false);
        await onSaved();
      } catch (err) {
        if (err instanceof AdminApiError) {
          // Try to parse the error body for a code; adminFetch already extracted message.
          const msg = err.message;
          if (/ZERO_TOOL_CONFIRMATION_REQUIRED/i.test(msg) || /zero[- ]tool/i.test(msg)) {
            setShowZeroToolConfirm(true);
          } else {
            setError(msg);
          }
        } else {
          setError(err instanceof Error ? err.message : "Network error");
        }
      } finally {
        setSaving(false);
      }
    },
    [
      agentId,
      allowlist,
      enabled,
      filterPredicateText,
      triggerConfigText,
      initial,
      isEdit,
      onSaved,
      promptTemplate,
      toolkitSlug,
      triggerType,
    ],
  );

  function handleSaveClick() {
    if (isPlanMode) return;
    // Client-side pre-check: empty allowlist → open confirm dialog.
    if (allowlist.length === 0) {
      setShowZeroToolConfirm(true);
      return;
    }
    void submit(false);
  }

  return (
    <div className="rounded border border-muted-foreground/15 p-4 space-y-4 bg-muted/10">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">{isEdit ? "Edit trigger" : "New trigger"}</h4>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="text-sm text-muted-foreground">{enabled ? "Enabled" : "Disabled"}</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled(!enabled)}
              disabled={saving}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                enabled ? "bg-primary" : "bg-muted"
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-background shadow-lg ring-0 transition-transform ${
                  enabled ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </label>
          <span title={isPlanMode ? "Cannot create triggers on plan-mode agents — this mode never executes tools." : undefined}>
            <Button size="sm" onClick={handleSaveClick} disabled={saving || isPlanMode}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </span>
          <Button size="sm" variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>

      {isPlanMode && (
        <p className="text-xs text-destructive">
          Cannot create triggers on plan-mode agents — this mode never executes tools.
        </p>
      )}

      <div className="grid grid-cols-2 gap-4">
        <FormField label="Toolkit">
          <Select
            value={toolkitSlug}
            onChange={(e) => {
              setToolkitSlug(e.target.value);
              setTriggerType("");
            }}
            disabled={saving || isEdit}
          >
            {availableToolkits.length === 0 && <option value="">No toolkits connected</option>}
            {availableToolkits.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </Select>
        </FormField>

        <FormField label="Trigger type">
          <Select
            value={triggerType}
            onChange={(e) => setTriggerType(e.target.value)}
            disabled={saving || isEdit || availableLoading}
          >
            <option value="">
              {availableLoading ? "Loading..." : "— Select a trigger type —"}
            </option>
            {filteredTriggers.map((t) => {
              const firstLine = (t.description ?? "").split("\n")[0] ?? "";
              const label = firstLine ? `${t.name} — ${firstLine}` : t.name;
              return (
                <option key={t.slug} value={t.slug}>{label}</option>
              );
            })}
            {isEdit && initial && !filteredTriggers.some((t) => t.slug === initial.trigger_type) && (
              <option value={initial.trigger_type}>{initial.trigger_type}</option>
            )}
          </Select>
        </FormField>
      </div>
      <FormError error={availableError} />

      {!isEdit && (
        <FormField
          label="Trigger config (JSON, Composio-side)"
          error={triggerConfigError ?? undefined}
          hint='Required for most trigger types. Example for Linear: {"team_id": "<team-uuid>"}. Check the trigger type instructions.'
        >
          <Textarea
            value={triggerConfigText}
            onChange={(e) => setTriggerConfigText(e.target.value)}
            rows={4}
            placeholder='{"team_id": "..."}'
            className="font-mono text-xs resize-y min-h-[80px]"
            disabled={saving}
          />
        </FormField>
      )}

      <FormField
        label="Filter predicate (JSON, optional, AgentPlane-side)"
        error={filterError ?? undefined}
        hint='Evaluated after signature verification. Example: {"payload.issue.priority": 1}. Empty means all events match.'
      >
        <Textarea
          value={filterPredicateText}
          onChange={(e) => setFilterPredicateText(e.target.value)}
          rows={4}
          placeholder='{"payload.field": "value"}'
          className="font-mono text-xs resize-y min-h-[80px]"
          disabled={saving}
        />
      </FormField>

      <FormField
        label="Prompt template"
        hint="Use {{payload.field}} to reference payload content. Payload renders inside a nonce-delimited block."
      >
        <Textarea
          value={promptTemplate}
          onChange={(e) => setPromptTemplate(e.target.value)}
          rows={5}
          placeholder="A new event fired. Summarize: {{payload.title}}"
          className="resize-y min-h-[100px]"
          disabled={saving}
        />
      </FormField>

      <FormField
        label="Tool allowlist (one tool name per line)"
        hint="For builtins use short names (e.g. Bash). For MCP tools use fully-qualified names (mcp__<server>__<tool>). TODO: live MCP-tool picker — see plan R10."
      >
        <Textarea
          value={allowlistText}
          onChange={(e) => setAllowlistText(e.target.value)}
          rows={5}
          placeholder={"Bash\nmcp__linear__save_issue"}
          className="font-mono text-xs resize-y min-h-[100px]"
          disabled={saving}
        />
        <p className="text-xs text-muted-foreground mt-1">{allowlist.length} tool(s) allowed</p>
      </FormField>

      <FormError error={error} />

      <ConfirmDialog
        open={showZeroToolConfirm}
        onOpenChange={setShowZeroToolConfirm}
        title="Save trigger with no tools?"
        confirmLabel="Save anyway"
        loadingLabel="Saving..."
        loading={saving}
        variant="default"
        onConfirm={() => void submit(true)}
      >
        This trigger will fire runs that cannot perform any actions — save anyway?
      </ConfirmDialog>
    </div>
  );
}
