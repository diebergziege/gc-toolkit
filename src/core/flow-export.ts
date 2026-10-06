import { GctkError } from "./errors.js";
import type { GenesysClient } from "./client.js";

type Fetch = typeof fetch;

/**
 * Exports a flow as Archy YAML via an Architect export job (read-only).
 * Returns the YAML text.
 */
export async function exportFlowYaml(
  client: GenesysClient,
  flow: { id?: string; name?: string; type?: string },
  opts: { fetchImpl?: Fetch; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const ref = flow.id ? { id: flow.id } : { name: flow.name, type: flow.type };
  if (!flow.id && !(flow.name && flow.type)) throw new GctkError("INVALID_FLOW_REF", "Pass the flow id, or its name and type.");
  const job = (await client.request<{ id: string }>("POST", "/api/v2/flows/export/jobs", {}, { flows: [{ flow: ref, exportType: "Yaml" }] })).body;
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  for (;;) {
    const state = (await client.get<{ status: string; downloadUrl?: string; messages?: Array<{ type: string; text: string }> }>(`/api/v2/flows/export/jobs/${job.id}`)).body;
    if (state.status === "Success" && state.downloadUrl) {
      const url = new URL(state.downloadUrl);
      if (url.protocol !== "https:") throw new GctkError("EXPORT_FAILED", "Export download URL is not https.");
      const res = await (opts.fetchImpl ?? fetch)(url);
      if (!res.ok) throw new GctkError("EXPORT_FAILED", `Downloading the export failed with HTTP ${res.status}.`);
      return await res.text();
    }
    if (state.status === "Failure") {
      throw new GctkError("EXPORT_FAILED", `Flow export failed: ${(state.messages ?? []).map((m) => `${m.type}: ${m.text}`).join("; ") || "no details"}`);
    }
    if (Date.now() > deadline) throw new GctkError("EXPORT_TIMEOUT", `Flow export job ${job.id} did not finish in time (status ${state.status}).`);
    await sleep(2000);
  }
}
