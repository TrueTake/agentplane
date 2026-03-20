import type { AgentPlane } from "../client";
import type { ComposioToolkit, ComposioTool } from "../types";

export class ComposioResource {
  constructor(private readonly _client: AgentPlane) {}

  /** List available Composio toolkits. */
  async toolkits(): Promise<ComposioToolkit[]> {
    const resp = await this._client._request<{ data: ComposioToolkit[] }>(
      "GET",
      "/api/composio/toolkits",
    );
    return resp.data;
  }

  /** List tools in a Composio toolkit. */
  async tools(toolkit: string): Promise<ComposioTool[]> {
    const resp = await this._client._request<{ data: ComposioTool[] }>(
      "GET",
      "/api/composio/tools",
      { query: { toolkit } },
    );
    return resp.data;
  }
}
