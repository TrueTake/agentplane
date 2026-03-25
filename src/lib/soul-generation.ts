import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

const SOULSPEC_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "STYLE.md",
  "AGENTS.md",
  "HEARTBEAT.md",
  "USER_TEMPLATE.md",
  "examples/good-outputs.md",
  "examples/bad-outputs.md",
] as const;

const FALLBACK_MODEL = "anthropic/claude-sonnet-4-5-20250514";

interface AgentContext {
  name: string;
  description: string | null;
  model: string;
  composio_toolkits: string[];
  skills: Array<{ folder: string; files: Array<{ path: string }> }>;
  plugins: Array<{ plugin_name: string }>;
  allowed_tools: string[];
}

function buildPrompt(
  agent: AgentContext,
  existingContent?: Record<string, string | null>,
): string {
  const toolsList = agent.allowed_tools.length > 0
    ? agent.allowed_tools.join(", ")
    : "none configured";

  const toolkitsList = agent.composio_toolkits.length > 0
    ? agent.composio_toolkits.join(", ")
    : "none";

  const skillsList = agent.skills.length > 0
    ? agent.skills.map((s) => `- ${s.folder} (${s.files.map((f) => f.path).join(", ")})`).join("\n")
    : "none";

  const pluginsList = agent.plugins.length > 0
    ? agent.plugins.map((p) => `- ${p.plugin_name}`).join("\n")
    : "none";

  const hasExisting = existingContent && Object.values(existingContent).some((v) => v !== null && v !== undefined);

  let prompt = `You are an expert at crafting SoulSpec v0.5 identity files for AI agents.

## SoulSpec v0.5 File Structure

### 1. SOUL.md — Core Personality (REQUIRED)
Required sections (use exact ## headers):
- \`## Personality\` — Temperament, humor, quirks
- \`## Tone\` — Communication tone and register
- \`## Principles\` — Core beliefs, values, operating rules

Recommended sections:
- \`## Worldview\` — Philosophical stance
- \`## Expertise\` — Knowledge domains and depth
- \`## Opinions\` — Actual positions on topics
- \`## Boundaries\` — What the persona refuses or avoids

### 2. IDENTITY.md — Who the Agent Is
Format: \`- **Key:** value\` on each line.
- \`- **Name:**\` — Display name
- \`- **Role:**\` — What the agent does
- \`- **Creature:**\` — Creature type (REQUIRED in SoulSpec v0.4+)
- \`- **Emoji:**\` — Representative emoji
- \`- **Vibe:**\` — One-line personality summary

### 3. STYLE.md — Communication Style
Sections (use exact ## headers):
- \`## Sentence Structure\` — Short/long, fragments, question style
- \`## Vocabulary\` — Preferred words, banned words, jargon level
- \`## Tone\` — Formal/casual, warm/dry, direct/diplomatic
- \`## Formatting\` — Emoji usage, markdown style, list preference
- \`## Rhythm\` — Pacing, paragraph length
- \`## Anti-patterns\` — Specific phrases to never use

### 4. AGENTS.md — Operational Workflow
How the agent operates. Task handling, tool usage, work rules.

### 5. HEARTBEAT.md — Periodic Check-In
What the agent does during idle/periodic check-ins. Health checks, status updates.

### 6. USER_TEMPLATE.md — User Profile Template
Template for user preferences. Copied to USER.md on first use.

### 7. examples/good-outputs.md — Good Output Examples
3-5 examples demonstrating the voice done right.

### 8. examples/bad-outputs.md — Anti-pattern Examples
3-5 examples showing what the agent should NOT do.

## Agent Configuration

- **Name**: ${agent.name}
- **Description**: ${agent.description || "No description provided"}
- **Model**: ${agent.model}
- **Tools**: ${toolsList}
- **Composio Toolkits**: ${toolkitsList}
- **Skills**:
${skillsList}
- **Plugins**:
${pluginsList}
`;

  if (hasExisting) {
    prompt += `\n## Existing Content (Refine and Improve)\n\n`;
    for (const file of SOULSPEC_FILES) {
      const content = existingContent[file];
      if (content) {
        prompt += `### ${file}\n\`\`\`markdown\n${content}\n\`\`\`\n\n`;
      }
    }
  }

  prompt += `## Instructions

Generate all 8 SoulSpec files for this agent.${hasExisting ? " Refine existing content where provided, generate fresh content for missing files." : ""} Make the content specific and actionable — avoid generic boilerplate. Tailor everything to this agent's purpose, tools, and capabilities.

Respond with a JSON object where each key is the file path and the value is the full markdown content. The keys must be exactly:
${SOULSPEC_FILES.map((f) => `- "${f}"`).join("\n")}

Return ONLY the JSON object. No markdown code fences, no explanation.`;

  return prompt;
}

export async function generateSoulFiles(
  agent: AgentContext,
  existingContent?: Record<string, string | null>,
): Promise<{ files: Record<string, string>; model_used: string }> {
  const env = getEnv();
  const prompt = buildPrompt(agent, existingContent);

  let model = agent.model || FALLBACK_MODEL;
  let files: Record<string, string> | null = null;

  // Try with agent's model first
  try {
    files = await tryGenerate(env.AI_GATEWAY_API_KEY, model, prompt);
  } catch (err) {
    logger.warn("Primary model failed for soul generation, falling back", { model, error: String(err) });
  }

  // Fall back to Claude Sonnet
  if (!files && model !== FALLBACK_MODEL) {
    model = FALLBACK_MODEL;
    files = await tryGenerate(env.AI_GATEWAY_API_KEY, model, prompt);
  }

  if (!files) {
    throw new Error("Failed to generate SoulSpec files with any model");
  }

  return { files, model_used: model };
}

async function tryGenerate(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<Record<string, string>> {
  // Try with JSON mode first
  let response = await callGateway(apiKey, model, prompt, true);

  // If JSON mode fails (some models don't support it), retry without
  if (!response.ok) {
    logger.warn("JSON mode failed, retrying without response_format", { model, status: response.status });
    response = await callGateway(apiKey, model, prompt, false);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    throw new Error(`AI Gateway returned ${response.status}: ${text}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("AI Gateway returned empty content");
  }

  // Parse JSON — handle markdown-wrapped responses
  const parsed = extractJson(content);
  validateSoulFiles(parsed);
  return parsed as Record<string, string>;
}

async function callGateway(
  apiKey: string,
  model: string,
  prompt: string,
  jsonMode: boolean,
): Promise<Response> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 8000,
  };
  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }

  return fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}

/** Extract JSON from a response that may be wrapped in markdown code fences */
function extractJson(content: string): unknown {
  // Try direct parse first
  try {
    return JSON.parse(content);
  } catch {
    // Strip markdown code fences
    const match = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (match?.[1]) {
      return JSON.parse(match[1]);
    }
    throw new Error("Could not parse response as JSON");
  }
}

function validateSoulFiles(parsed: unknown): asserts parsed is Record<string, string> {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Response is not a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  // Be lenient — accept partial results, fill missing with empty
  for (const file of SOULSPEC_FILES) {
    if (typeof obj[file] !== "string") {
      obj[file] = "";
    }
  }
}
