/**
 * Server-info tool: `priority_get_server_info`.
 *
 * Returns the Priority version, the current login name, and the companies
 * available in the environment — three cheap reads, all verified in
 * docs/priority-api-verified.md:
 * - `GetPriorityVersion()` → unbound function, `{"value":"25.0-…"}`.
 * - `GetLoginName()` → unbound function, `{"value":"apidemo"}`.
 * - `GETCOMPANIES?$top=100` → entity-set list of `{NAME,TITLE}`.
 *
 * ≤3 HTTP requests, all cached by the shared client's GET cache.
 */

import type { ODataFunctionResult, ODataListResponse } from "../priority/types.js";
import type { ReadToolContext } from "./context.js";

export interface ServerInfoCompany {
  NAME: string;
  TITLE?: string;
}

export interface ServerInfo {
  priorityVersion: string;
  loginName: string;
  companies: ServerInfoCompany[];
}

/** Read server info with ≤3 HTTP requests (GetPriorityVersion, GetLoginName, GETCOMPANIES). */
export async function getServerInfo(ctx: ReadToolContext): Promise<ServerInfo> {
  const [version, login, companiesResponse] = await Promise.all([
    ctx.client.get<ODataFunctionResult>("GetPriorityVersion()", { op: "GetPriorityVersion()" }),
    ctx.client.get<ODataFunctionResult>("GetLoginName()", { op: "GetLoginName()" }),
    ctx.client.get<ODataListResponse<ServerInfoCompany>>("GETCOMPANIES?$top=100", {
      op: "GETCOMPANIES?$top=100",
    }),
  ]);

  const priorityVersion = typeof version.value === "string" ? version.value : "";
  const loginName = typeof login.value === "string" ? login.value : "";
  const companies = Array.isArray(companiesResponse.value) ? companiesResponse.value : [];

  return { priorityVersion, loginName, companies };
}
