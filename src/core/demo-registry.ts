import type { GenesysClient } from "./client.js";
import { GctkError } from "./errors.js";

/**
 * Which demos are deployed in an org, kept in the org itself (decision 2026-10-09: a demo is
 * deployed once per org, and solution consultants share orgs). A data table "gctk demos" holds one
 * row per demo, keyed by the demo's id, with the deploy record as JSON: what gctk created there,
 * the ids it uses, who deployed it, the presenters. Every gctk reads it before it deploys, joins
 * or removes, so it does not matter on which computer a demo was deployed. Genesys refuses a second
 * row with the same key (flows.datatables.not.unique, checked live in genesys-psuk 2026-10-09), so
 * creating the row is the lock: only one deploy can start. A field holds at least 60,000 characters.
 */

export const REGISTRY_TABLE = "gctk demos";
/** A deploy that has not written for this long has stopped (a crash, a closed laptop); another may take over. */
export const STALE_MS = 30 * 60 * 1000;

export interface OrgDeployment<R = Record<string, unknown>> {
  demo: string;
  state: "deploying" | "deployed" | "incomplete";
  /** Who started the deploy (the presenter, or the computer's user). */
  by: string;
  at: string;
  /** Last write of the running deploy. */
  heartbeat: string;
  version: string;
  /** Who presents it, each with an own customer contact (salutation, name, phone, email of their persona). */
  presenters: Presenter[];
  /** The deploy record without the local profile name. */
  record: R;
  error?: string;
}

export interface Presenter {
  id: string;
  name: string;
  /** The customer persona's name: unique in the org. */
  customer?: string;
  contactId?: string;
}

type Obj = Record<string, any>;
const schema = {
  $schema: "http://json-schema.org/draft-04/schema#",
  type: "object",
  additionalProperties: false,
  required: ["key"],
  properties: {
    key: { title: "key", type: "string", $id: "/properties/key" },
    entry: { title: "entry", type: "string", $id: "/properties/entry" },
  },
};
const notFound = (err: unknown) => /HTTP_404/.test((err as { code?: string }).code ?? "");
const duplicate = (err: unknown) => /not\.unique|duplicate|already exists/i.test((err as Error).message ?? "");

export async function findRegistry(c: GenesysClient): Promise<string | undefined> {
  const r = (await c.get<Obj>("/api/v2/flows/datatables", { name: REGISTRY_TABLE, pageSize: 25 })).body;
  return ((r.entities ?? []) as Obj[]).find((t) => t.name === REGISTRY_TABLE)?.id;
}

/** The registry table, created the first time a demo is deployed into the org. */
export async function ensureRegistry(c: GenesysClient, divisionId?: string): Promise<string> {
  const have = await findRegistry(c);
  if (have) return have;
  try {
    const t = (await c.request<Obj>("POST", "/api/v2/flows/datatables", {}, {
      name: REGISTRY_TABLE,
      description: "Which gctk demos are deployed in this org (written by gctk; do not edit).",
      ...(divisionId ? { division: { id: divisionId } } : {}),
      schema,
    })).body;
    return t.id as string;
  } catch (err) {
    // Someone else created it a moment ago.
    const again = await findRegistry(c);
    if (again) return again;
    throw err;
  }
}

export async function readDeployment<R>(c: GenesysClient, table: string | undefined, demo: string): Promise<OrgDeployment<R> | undefined> {
  if (!table) return undefined;
  try {
    const row = (await c.get<Obj>(`/api/v2/flows/datatables/${table}/rows/${encodeURIComponent(demo)}`, { showbrief: false })).body;
    return JSON.parse(String(row.entry ?? "{}")) as OrgDeployment<R>;
  } catch (err) {
    if (notFound(err)) return undefined;
    throw err;
  }
}

/** Creates the demo's row: fails with DEMO_TAKEN when another deploy registered it first. */
export async function claimDeployment<R>(c: GenesysClient, table: string, d: OrgDeployment<R>): Promise<void> {
  try {
    await c.request("POST", `/api/v2/flows/datatables/${table}/rows`, {}, { key: d.demo, entry: JSON.stringify(d) });
  } catch (err) {
    if (duplicate(err)) throw new GctkError("DEMO_TAKEN", "Someone else registered this demo in the org a moment ago. Reload the page to see their deployment.");
    throw err;
  }
}

export async function writeDeployment<R>(c: GenesysClient, table: string, d: OrgDeployment<R>): Promise<void> {
  await c.request("PUT", `/api/v2/flows/datatables/${table}/rows/${encodeURIComponent(d.demo)}`, {}, { key: d.demo, entry: JSON.stringify(d) });
}

export async function dropDeployment(c: GenesysClient, table: string, demo: string): Promise<void> {
  try {
    await c.request("DELETE", `/api/v2/flows/datatables/${table}/rows/${encodeURIComponent(demo)}`);
  } catch (err) {
    if (!notFound(err)) throw err;
  }
}

/** A deploy that is still running (and has written recently). */
export const deployingNow = (d: OrgDeployment<unknown>, now = Date.now()) => d.state === "deploying" && now - Date.parse(d.heartbeat) < STALE_MS;
