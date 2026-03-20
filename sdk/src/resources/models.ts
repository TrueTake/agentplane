import type { AgentPlane } from "../client";
import type { CatalogModel } from "../types";

export class ModelsResource {
  constructor(private readonly _client: AgentPlane) {}

  /** List available models from the AI Gateway catalog. */
  async list(): Promise<CatalogModel[]> {
    const resp = await this._client._request<{ models: CatalogModel[] }>(
      "GET",
      "/api/models",
    );
    return resp.models;
  }
}
