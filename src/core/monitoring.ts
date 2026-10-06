import type { GenesysClient, Query } from "./client.js";
import { GctkError } from "./errors.js";

/**
 * Monitoring: how many objects of a kind the org has, next to the org's own limit for it.
 * Read-only: GETs and read POSTs (…/query) through GenesysClient.request, nothing else.
 * Counts, endpoints, limit keys and permissions were checked against the spec and live in
 * a dev org (2026-09-29). A metric without a limit key shows only its count; never guess one.
 */

export type CountSource =
  /** List endpoint with a `total` (pageSize=1 is enough). */
  | { kind: "total"; path: string; query?: Query }
  /** Cursor-paged list without a total: walk the pages and count the entities. */
  | { kind: "walk"; path: string; query?: Query }
  /** Task management …/query with select=Count (filters are required; [] means all). */
  | { kind: "count-query"; path: string }
  /** Anything else; `memo` is shared by all metrics of one run (e.g. one walk for two cards). */
  | { kind: "fn"; run: (client: GenesysClient, memo: Memo) => Promise<Counted> };

export type Memo = Map<string, Promise<unknown>>;
export interface Counted {
  count: number;
  atLeast?: boolean;
  /** One line under the number, e.g. what the count leaves out. */
  note?: string;
}

export interface MonitorMetric {
  id: string;
  label: string;
  group: string;
  count: CountSource;
  /** Key in GET /api/v2/organizations/limits/namespaces/{namespace}. */
  limit?: { namespace: string; key: string };
  /** From the spec, shown when the count is not readable. */
  permissions: string[];
  hint?: string;
}

export const MONITOR_GROUPS = ["Integrations", "Architect", "Routing", "People", "AI and digital", "Other"] as const;

export const MONITOR_METRICS: MonitorMetric[] = [
  { id: "dataactions", label: "Data actions", group: "Integrations", count: { kind: "fn", run: async (c, memo) => {
    const s = await dataActionStats(c, memo);
    return { count: s.custom, atLeast: s.truncated, note: s.builtIn ? `plus ${s.builtIn} built-in actions of integrations, not counted` : undefined };
  } }, limit: { namespace: "dataactions", key: "actions.total.max" }, permissions: ["integrations:action:view"] },
  { id: "dataactions-per-integration", label: "Data actions in one integration", group: "Integrations", count: { kind: "fn", run: async (c, memo) => {
    const s = await dataActionStats(c, memo);
    const top = s.integrations[0];
    return { count: top?.custom ?? 0, atLeast: s.truncated, note: top?.custom ? `most: ${top.name}` : undefined };
  } }, limit: { namespace: "dataactions", key: "actions.integration.max" }, permissions: ["integrations:action:view"] },
  { id: "dataaction-drafts", label: "Data action drafts", group: "Integrations", count: { kind: "fn", run: async (c, memo) => {
    const s = await dataActionStats(c, memo);
    if (s.drafts === undefined) throw new GctkError("NO_TOTAL", "Drafts not readable.");
    return { count: s.drafts, note: s.drafts ? `${s.newDrafts} never published, ${s.drafts - s.newDrafts} edits of published actions` : undefined };
  } }, permissions: ["integrations:action:view"] },
  { id: "integrations", label: "Integrations", group: "Integrations", count: { kind: "total", path: "/api/v2/integrations" }, permissions: ["integrations:integration:view"] },
  { id: "flows", label: "Flows", group: "Architect", count: { kind: "total", path: "/api/v2/flows" }, limit: { namespace: "architect", key: "flows.max" }, permissions: ["architect:flow:view"] },
  { id: "datatables", label: "Data tables", group: "Architect", count: { kind: "total", path: "/api/v2/flows/datatables" }, limit: { namespace: "datatables", key: "tables.max.allowed" }, permissions: ["architect:datatable:view"] },
  { id: "scripts", label: "Scripts", group: "Architect", count: { kind: "total", path: "/api/v2/scripts" }, permissions: ["scripter:script:view"] },
  { id: "queues", label: "Queues", group: "Routing", count: { kind: "total", path: "/api/v2/routing/queues" }, limit: { namespace: "routing", key: "queues.max" }, permissions: ["routing:queue:view"] },
  { id: "wrapupcodes", label: "Wrap-up codes", group: "Routing", count: { kind: "total", path: "/api/v2/routing/wrapupcodes" }, limit: { namespace: "routing", key: "wrapup.codes.max" }, permissions: ["routing:wrapupCode:view"] },
  { id: "skills", label: "Skills", group: "Routing", count: { kind: "total", path: "/api/v2/routing/skills" }, limit: { namespace: "skills", key: "skill.count.max" }, permissions: ["routing:skill:view"] },
  { id: "languages", label: "Languages", group: "Routing", count: { kind: "total", path: "/api/v2/routing/languages" }, limit: { namespace: "skills", key: "language.count.max" }, permissions: [] },
  { id: "worktypes", label: "Work types", group: "Routing", count: { kind: "count-query", path: "/api/v2/taskmanagement/worktypes/query" }, limit: { namespace: "task.management", key: "worktypes.max" }, permissions: ["workitems:worktype:view"] },
  { id: "workbins", label: "Workbins", group: "Routing", count: { kind: "count-query", path: "/api/v2/taskmanagement/workbins/query" }, limit: { namespace: "task.management", key: "workbins.max" }, permissions: ["workitems:workbin:view"] },
  { id: "users", label: "Active users", group: "People", count: { kind: "total", path: "/api/v2/users" }, permissions: [] },
  { id: "groups", label: "Groups", group: "People", count: { kind: "total", path: "/api/v2/groups" }, limit: { namespace: "groups", key: "group.count.max" }, permissions: [] },
  { id: "teams", label: "Teams", group: "People", count: { kind: "walk", path: "/api/v2/teams" }, limit: { namespace: "groups", key: "teams.max" }, permissions: ["groups:team:view"] },
  { id: "roles", label: "Roles", group: "People", count: { kind: "total", path: "/api/v2/authorization/roles" }, limit: { namespace: "authorization", key: "org.roles.max" }, permissions: ["authorization:role:view"] },
  { id: "divisions", label: "Divisions", group: "People", count: { kind: "total", path: "/api/v2/authorization/divisions" }, limit: { namespace: "authorization", key: "max.divisions.per.org" }, permissions: [] },
  { id: "aiagents", label: "AI agents", group: "AI and digital", count: { kind: "total", path: "/api/v2/agentic/virtualagents" }, limit: { namespace: "agentic.virtual.agents", key: "agents.max" }, permissions: ["agentic:virtualAgent:view"] },
  { id: "nludomains", label: "NLU domains", group: "AI and digital", count: { kind: "total", path: "/api/v2/languageunderstanding/domains" }, limit: { namespace: "language.understanding", key: "v3.domains.max" }, permissions: ["languageUnderstanding:nluDomain:view"] },
  { id: "knowledgebases", label: "Knowledge bases", group: "AI and digital", count: { kind: "walk", path: "/api/v2/knowledge/knowledgebases" }, limit: { namespace: "knowledge", key: "knowledgebases.max" }, permissions: ["knowledge:knowledgebase:view"] },
  { id: "assistants", label: "Copilot assistants", group: "AI and digital", count: { kind: "walk", path: "/api/v2/assistants" }, permissions: ["assistants:assistant:view"] },
  { id: "webdeployments", label: "Messenger deployments", group: "AI and digital", count: { kind: "total", path: "/api/v2/webdeployments/deployments" }, limit: { namespace: "web.deployments", key: "deployments.max" }, permissions: ["webDeployments:deployment:view"] },
  { id: "webconfigurations", label: "Messenger configurations", group: "AI and digital", count: { kind: "total", path: "/api/v2/webdeployments/configurations" }, limit: { namespace: "web.deployments", key: "configuration.max" }, permissions: ["webDeployments:configuration:view"] },
  { id: "learningmodules", label: "Learning modules", group: "Other", count: { kind: "total", path: "/api/v2/learning/modules" }, limit: { namespace: "learning", key: "modules.max" }, permissions: ["learning:module:view"] },
  { id: "contactlists", label: "Contact lists", group: "Other", count: { kind: "total", path: "/api/v2/outbound/contactlists" }, limit: { namespace: "outbound", key: "contact.lists.max" }, permissions: ["outbound:contactList:view"] },
  { id: "segments", label: "Journey segments", group: "Other", count: { kind: "total", path: "/api/v2/journey/segments" }, limit: { namespace: "journey", key: "segment.max" }, permissions: ["journey:segment:view"] },
  { id: "actionmaps", label: "Journey action maps", group: "Other", count: { kind: "total", path: "/api/v2/journey/actionmaps" }, limit: { namespace: "journey", key: "actionmap.max" }, permissions: ["journey:actionmap:view"] },
];

/**
 * GET /integrations/actions lists custom actions ("custom_-_…") and the built-in actions that
 * integrations such as Salesforce or Dynamics bring along ("static_-_…"). Only custom actions are
 * counted against actions.total.max: a sandbox org lists 531 with a limit of 500 and still works,
 * 451 of them custom (checked 2026-09-29). Drafts carry the id of their action; a draft whose id
 * is not among the published actions was never published.
 */
export interface IntegrationActions {
  id: string;
  name: string;
  /** integrationType.id, e.g. purecloud-data-actions, custom-rest-actions, function-data-actions. */
  type?: string;
  enabled?: boolean;
  custom: number;
  builtIn: number;
  drafts: number;
  newDrafts: number;
}
interface DataActionStats {
  custom: number;
  builtIn: number;
  truncated: boolean;
  /** Undefined when the drafts could not be read. */
  drafts?: number;
  newDrafts: number;
  /** Integrations with actions or drafts, and data action integrations without any; fullest first. */
  integrations: IntegrationActions[];
}
type ActionRow = { id?: string; integrationId?: string };
type IntegrationRow = { id?: string; name?: string; integrationType?: { id?: string }; intendedState?: string };
/** Integration types that hold data actions (web services, Genesys Cloud, functions, Lambda, CRMs). */
const DATA_ACTION_TYPE = /data-?actions|datadip|rest-actions/;

async function walk<T>(client: GenesysClient, path: string): Promise<{ items: T[]; truncated: boolean }> {
  const { paged } = await client.getAll(path, { pageSize: 100 }, 10000);
  if (!paged) throw new GctkError("NO_TOTAL", `${path} is not a list.`);
  return { items: paged.items as T[], truncated: paged.truncated };
}

function dataActionStats(client: GenesysClient, memo: Memo): Promise<DataActionStats> {
  if (!memo.has("dataactions")) {
    memo.set("dataactions", (async () => {
      // Drafts and integration names are extras: without them the counts still stand.
      const [actions, drafts, integrations] = await Promise.all([
        walk<ActionRow>(client, "/api/v2/integrations/actions"),
        walk<ActionRow>(client, "/api/v2/integrations/actions/drafts").catch(() => undefined),
        walk<IntegrationRow>(client, "/api/v2/integrations").catch(() => undefined),
      ]);
      const rows = new Map<string, IntegrationActions>();
      const row = (id: string) => {
        let r = rows.get(id);
        if (!r) rows.set(id, (r = { id, name: id, custom: 0, builtIn: 0, drafts: 0, newDrafts: 0 }));
        return r;
      };
      // Data action integrations are listed even without actions (they show where there is room).
      for (const i of integrations?.items ?? []) if (i.id && DATA_ACTION_TYPE.test(i.integrationType?.id ?? "")) row(i.id);
      const published = new Set<string>();
      let custom = 0;
      for (const a of actions.items) {
        const isCustom = String(a.id).startsWith("custom_");
        if (isCustom) custom++;
        if (a.id) published.add(a.id);
        if (a.integrationId) row(a.integrationId)[isCustom ? "custom" : "builtIn"]++;
      }
      let newDrafts = 0;
      for (const d of drafts?.items ?? []) {
        const isNew = !published.has(String(d.id));
        if (isNew) newDrafts++;
        if (!d.integrationId) continue;
        const r = row(d.integrationId);
        r.drafts++;
        if (isNew) r.newDrafts++;
      }
      for (const i of integrations?.items ?? []) if (i.id && rows.has(i.id)) Object.assign(rows.get(i.id)!, { name: i.name || i.id, type: i.integrationType?.id, enabled: i.intendedState ? i.intendedState === "ENABLED" : undefined });
      const list = [...rows.values()].sort((a, b) => b.custom - a.custom || b.drafts - a.drafts || a.name.localeCompare(b.name));
      return { custom, builtIn: actions.items.length - custom, truncated: actions.truncated, drafts: drafts?.items.length, newDrafts, integrations: list };
    })());
  }
  return memo.get("dataactions") as Promise<DataActionStats>;
}

/** Warn from 80 %, alert from 95 % of the limit. */
export const WARN_AT = 0.8;
export const ALERT_AT = 0.95;
/** A cursor walk stops here; the card then says "at least". */
const WALK_MAX = 5000;
const PARALLEL = 4;

export type MonitorLevel = "ok" | "warn" | "alert" | "none" | "error";

export interface MonitorResult {
  id: string;
  label: string;
  group: string;
  count?: number;
  /** The walk stopped before the end: the real count is higher. */
  atLeast?: boolean;
  limit?: number;
  /** 0..100, rounded; only with a count and a limit. */
  percent?: number;
  level: MonitorLevel;
  error?: string;
  note?: string;
  hint?: string;
}

export interface MonitorReport {
  profile: string;
  at: string;
  metrics: MonitorResult[];
  /** Namespaces whose limits could not be read (cards show the count only). */
  limitErrors: string[];
  /** Data actions per integration, when the data action cards ran. */
  integrations?: IntegrationActions[];
}

export function levelFor(count: number | undefined, limit: number | undefined): MonitorLevel {
  if (count === undefined) return "error";
  if (!limit) return "none";
  const share = count / limit;
  return share >= ALERT_AT ? "alert" : share >= WARN_AT ? "warn" : "ok";
}

async function countOf(client: GenesysClient, src: CountSource, memo: Memo): Promise<Counted> {
  if (src.kind === "fn") return src.run(client, memo);
  if (src.kind === "total") {
    const { body } = await client.get<{ total?: unknown }>(src.path, { ...src.query, pageSize: 1 });
    if (typeof body?.total !== "number") throw new GctkError("NO_TOTAL", `${src.path} returned no total.`);
    return { count: body.total };
  }
  if (src.kind === "count-query") {
    const { body } = await client.request<{ count?: unknown }>("POST", src.path, {}, { filters: [], select: "Count" });
    if (typeof body?.count !== "number") throw new GctkError("NO_TOTAL", `${src.path} returned no count.`);
    return { count: body.count };
  }
  const { paged } = await client.getAll(src.path, { ...src.query, pageSize: 100 }, WALK_MAX);
  if (!paged) throw new GctkError("NO_TOTAL", `${src.path} is not a list.`);
  return { count: paged.items.length, atLeast: paged.truncated || undefined };
}

function errorText(err: unknown, m: MonitorMetric): string {
  const code = err instanceof GctkError ? err.code : "";
  if (code === "HTTP_403") return m.permissions.length ? `No permission (needs ${m.permissions.join(" or ")})` : "No permission";
  if (code === "HTTP_404") return "Not available in this org";
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 200 ? `${msg.slice(0, 199)}…` : msg;
}

/** Runs fn over items with at most `n` requests in flight (keeps clear of rate limits). */
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

export async function readLimits(client: GenesysClient, namespaces: string[]): Promise<{ limits: Map<string, number>; errors: string[] }> {
  const limits = new Map<string, number>();
  const errors: string[] = [];
  await pool(namespaces, PARALLEL, async (ns) => {
    try {
      const { body } = await client.get<{ entities?: Array<{ key?: unknown; value?: unknown }> }>(`/api/v2/organizations/limits/namespaces/${encodeURIComponent(ns)}`);
      for (const e of body?.entities ?? []) {
        if (typeof e.key === "string" && typeof e.value === "number") limits.set(`${ns}/${e.key}`, e.value);
      }
    } catch {
      errors.push(ns);
    }
  });
  return { limits, errors: errors.sort() };
}

export async function monitorOrg(client: GenesysClient, metrics: MonitorMetric[] = MONITOR_METRICS, now = new Date()): Promise<MonitorReport> {
  const memo: Memo = new Map();
  const namespaces = [...new Set(metrics.flatMap((m) => (m.limit ? [m.limit.namespace] : [])))];
  const [{ limits, errors }, counts] = await Promise.all([
    readLimits(client, namespaces),
    pool(metrics, PARALLEL, async (m) => {
      try {
        return await countOf(client, m.count, memo);
      } catch (err) {
        return { error: errorText(err, m) };
      }
    }),
  ]);
  const results = metrics.map((m, i): MonitorResult => {
    const c = counts[i]!;
    const limit = m.limit ? limits.get(`${m.limit.namespace}/${m.limit.key}`) : undefined;
    if ("error" in c) return { id: m.id, label: m.label, group: m.group, limit, level: "error", error: c.error, hint: m.hint };
    const percent = limit ? Math.round((c.count / limit) * 100) : undefined;
    return { id: m.id, label: m.label, group: m.group, count: c.count, atLeast: c.atLeast, limit, percent, level: levelFor(c.count, limit), note: c.note, hint: m.hint };
  });
  const stats = memo.has("dataactions") ? await (memo.get("dataactions") as Promise<DataActionStats>).catch(() => undefined) : undefined;
  return { profile: client.profile.name, at: now.toISOString(), metrics: results, limitErrors: errors, integrations: stats?.integrations };
}
