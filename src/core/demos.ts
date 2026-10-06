import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { GenesysClient } from "./client.js";
import { loadCredentials } from "./credentials.js";
import { type LocalHandle, type LocalRuntime, startLocal } from "./demo-local.js";
import { DEMO_PERMISSIONS } from "./demo-permissions.js";
import { GctkError } from "./errors.js";
import { exportFlowYaml } from "./flow-export.js";
import { gctkHome } from "./paths.js";
import { listProfiles, loadProfile } from "./profiles.js";
import { environmentFor } from "./regions.js";

/**
 * Demos (UI page "Demos"): a whole demo, deployed into any org with one button.
 *
 * A demo package is a folder with `demo.yaml` (what belongs to it, parameters, prerequisites,
 * manual steps, what runs on this computer) and `snapshot.json`: the objects read from the source
 * org, every source id replaced by a token `@{type:name}`. The demos ship with the plugin in
 * `demos/<id>/`; users cannot add their own. Deploy
 * creates the objects in the target org in a fixed order, reuses objects that already have the
 * name, and swaps the tokens for the target's ids and the parameters. What it created is recorded
 * per org, so Remove deletes exactly that.
 *
 * Which org a snapshot is read from is not part of the package: it is a setting on the maintainer's
 * computer (`demo-sources.json` in the gctk home, set with the hidden `gctk demo-source`), together
 * with the texts that must not leave that org (a person's name). Without it no snapshot is offered.
 */

type Obj = Record<string, any>;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const invalid = (msg: string) => new GctkError("INVALID_INPUT", msg);

// ----------------------------------------------------------------- manifest

export interface DemoCommand {
  id: string;
  label: string;
  /** Relative to the demo package. */
  cwd: string;
  run: string[];
  /** Values may use @{org.clientId}, @{org.clientSecret}, @{org.region} and object tokens of the deploy. */
  env?: Record<string, string>;
  /** Only when the org is not this computer's snapshot source (e.g. skip a preflight that knows the source's ids). */
  envOtherOrg?: Record<string, string>;
  url?: string;
}

/** A value the presenter enters at deploy, used in the snapshot as @{param:id} (and @{param:id.digits}, @{param:id.masked} for phones). */
export interface DemoParameter {
  id: string;
  label: string;
  format?: "phone" | "email" | "text";
  optional?: boolean;
  /** Snapshot: these fields of the contact carry the value (workPhone, cellPhone, whatsAppId, workEmail …). */
  contact?: { name: string; fields: string[] };
}

export interface DemoManifest {
  name: string;
  description?: string;
  include: Array<{ type: string; names: string[] }>;
  parameters?: DemoParameter[];
  /** Snapshot: texts of the source org replaced in every object (e.g. a person's name by @{presenter.name}). */
  replace?: Array<{ value: string; with: string }>;
  /** Objects the package adds that the source org does not have (deployed with the snapshot's, in type order). */
  create?: Array<{ type: string; name: string; spec: Obj; /** Only deployed for this customer channel. */ channel?: string }>;
  /** Changes to snapshot flows for one channel: remove actions by Architect tracking id. */
  channelChanges?: Array<{ channel: string; type: string; name: string; removeActions: number[] }>;
  /** How the customer reaches the demo; the presenter picks one at deploy (the first is the default). */
  channels?: Array<{ id: string; label: string; description?: string }>;
  prerequisites?: Array<{ text: string; check?: { get: string; query?: Record<string, string>; expect?: "ok" | "entities" } }>;
  manual?: string[];
  commands?: DemoCommand[];
  /** Runs inside gctk: pages for the agent script and Copilot answers. */
  local?: LocalRuntime;
  /** The demo's inbound message flow; the deploy routes the chosen WhatsApp number to it (only for that channel, if set). */
  messageRouting?: { flow: string; channel?: string };
}

export interface DemoInfo {
  id: string;
  /** Folder of demo.yaml and snapshot.json. */
  folder: string;
  /** A snapshot source is set on this computer and its profile exists, so a new snapshot can be taken. */
  canSnapshot: boolean;
  /** The profile snapshots are taken from on this computer. */
  sourceProfile?: string;
  manifest?: DemoManifest;
  /** story.yaml of the package plus a trigger reference built from the snapshot. */
  story?: DemoStory;
  /** What the org's OAuth client needs, by when it needs it ("a | b": one of them). */
  permissions?: Array<{ title: string; items: string[] }>;
  error?: string;
  snapshot?: { at: string; objects: number; unresolved: number; contents: Array<{ label: string; names: string[] }> };
  deployments: Array<{ profile: string; at: string; created: number; reused: number; division?: string; channel?: string; presenter?: string; params?: Record<string, string>; routing?: { integration: string; phone?: string } }>;
}

interface Source {
  id: string;
  /** Where demo.yaml and snapshot.json are. */
  pkg: string;
}

const recordDir = (id: string) => path.join(gctkHome(), "demos", id);

/** Where this computer takes a demo's snapshot from, and which of that org's texts it replaces. */
export interface SnapshotSource {
  profile: string;
  replace?: Array<{ value: string; with: string }>;
}

const sourcesFile = () => path.join(gctkHome(), "demo-sources.json");
const readSources = (): Record<string, SnapshotSource> => {
  try {
    return JSON.parse(fs.readFileSync(sourcesFile(), "utf8")) as Record<string, SnapshotSource>;
  } catch {
    return {};
  }
};

export const snapshotSource = (id: string): SnapshotSource | undefined => readSources()[id];

/** Sets (or with no source removes) where this computer takes the demo's snapshot from. */
export function setSnapshotSource(id: string, source: SnapshotSource | undefined): void {
  sourceOf(id);
  if (source) loadProfile(source.profile);
  const all = readSources();
  if (source) all[id] = source;
  else delete all[id];
  fs.mkdirSync(gctkHome(), { recursive: true });
  fs.writeFileSync(sourcesFile(), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
}

/** The demos that ship with the plugin (next to dist/ in an install, or the repository). */
export function builtInDemosDir(): string | undefined {
  if (process.env.GCTK_DEMOS_DIR) return process.env.GCTK_DEMOS_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.resolve(here, "../demos"), path.resolve(here, "../../demos")].find((d) => fs.existsSync(d));
}

function sources(): Source[] {
  const out: Source[] = [];
  const dir = builtInDemosDir();
  if (dir && fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).sort()) {
      const pkg = path.join(dir, name);
      if (fs.existsSync(path.join(pkg, "demo.yaml"))) out.push({ id: name, pkg });
    }
  }
  return out;
}

export function loadManifest(pkg: string): DemoManifest {
  const file = path.join(pkg, "demo.yaml");
  if (!fs.existsSync(file)) throw invalid(`${pkg} has no demo.yaml.`);
  const m = YAML.parse(fs.readFileSync(file, "utf8")) as DemoManifest;
  if (!m?.name || !Array.isArray(m.include)) throw invalid(`${file} needs name and include.`);
  for (const i of [...m.include, ...(m.create ?? [])]) if (!TYPES[i.type]) throw invalid(`${file}: unknown type "${i.type}". Known: ${Object.keys(TYPES).join(", ")}.`);
  return m;
}

function sourceOf(id: string): Source {
  const s = sources().find((x) => x.id === id);
  if (!s) throw invalid("Unknown demo.");
  return s;
}

export function listDemos(): DemoInfo[] {
  const profiles = new Set(listProfiles());
  return sources().map((src) => {
    const id = src.id;
    const base: DemoInfo = { id, folder: src.pkg, canSnapshot: false, deployments: listDeployments(id) };
    try {
      base.manifest = loadManifest(src.pkg);
      const source = snapshotSource(id);
      if (source) base.sourceProfile = source.profile;
      base.canSnapshot = Boolean(source && profiles.has(source.profile));
      base.permissions = demoPermissions(base.manifest, readSnapshot(src.pkg));
      base.story = loadStory(src.pkg, base.manifest, readSnapshot(src.pkg));
    } catch (err) {
      base.error = (err as Error).message;
    }
    const snap = readSnapshot(src.pkg);
    if (snap) {
      const objects = [...snap.objects, ...(base.manifest?.create ?? [])];
      const contents = ORDER.map((t) => ({ label: TYPES[t]!.label, names: objects.filter((o) => o.type === t).map((o) => o.name) })).filter((x) => x.names.length);
      base.snapshot = { at: snap.at, objects: objects.length, unresolved: snap.unresolved.length, contents };
    }
    return base;
  });
}

// ----------------------------------------------------------------- snapshot

interface SnapObject {
  type: string;
  name: string;
  spec: Obj;
}
interface Snapshot {
  at: string;
  region: string;
  objects: SnapObject[];
  /** Ids in the specs that belong to nothing in the package (left as they are, reported). */
  unresolved: string[];
}

const readSnapshot = (pkg: string): Snapshot | undefined => {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkg, "snapshot.json"), "utf8")) as Snapshot;
  } catch {
    return undefined;
  }
};

interface Captured {
  name: string;
  spec: Obj;
  /** Other objects this one needs (included automatically). */
  deps?: Array<{ type: string; id: string }>;
  /** Ids inside the object others may point to (e.g. responses of a library): source id → sub key. */
  subs?: Record<string, string>;
  /** Ids that stay the same in the target (agent script pages: the client chooses them). */
  keep?: string[];
  divisionId?: string;
}

interface DeployEnv {
  client: GenesysClient;
  division: { id: string; name: string };
  presenter?: string;
  log: (line: string) => void;
  /** Per object id what the last refresh imported and what the org then exported (hashes), kept in the deploy record. */
  refreshed: Record<string, { source: string; result: string }>;
}

interface TypeDef {
  label: string;
  /** Finds source objects by name. */
  byName(c: GenesysClient, name: string): Promise<Obj | undefined>;
  byId(c: GenesysClient, id: string): Promise<Obj>;
  capture(c: GenesysClient, raw: Obj): Promise<Captured>;
  /** Existing object of that name in the target. */
  find(c: GenesysClient, name: string): Promise<string | undefined>;
  create(spec: Obj, env: DeployEnv): Promise<{ id: string; subs?: Record<string, string> }>;
  /** Sub ids of an object that already existed (sub key → id). */
  subsOf?(c: GenesysClient, id: string, spec: Obj): Promise<Record<string, string>>;
  /** Brings an existing object up to date (only used when its spec carries parameters). */
  update?(c: GenesysClient, id: string, spec: Obj): Promise<void>;
  /** Brings an object the demo created to the snapshot's state on every deploy; says whether it changed anything. */
  refresh?(id: string, spec: Obj, env: DeployEnv): Promise<boolean>;
  remove(c: GenesysClient, id: string): Promise<void>;
}

const strip = (o: Obj, ...keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
async function all(c: GenesysClient, p: string, q: Obj = {}): Promise<Obj[]> {
  const { first, paged } = await c.getAll(p, { pageSize: 100, ...q }, 5000);
  return (paged?.items ?? (first.body as Obj)?.entities ?? []) as Obj[];
}
async function firstNamed(c: GenesysClient, p: string, name: string, q: Obj = {}, key = "name"): Promise<Obj | undefined> {
  return (await all(c, p, q)).find((x) => x[key] === name);
}
async function queryNamed(c: GenesysClient, p: string, name: string): Promise<Obj | undefined> {
  const r = await c.request<Obj>("POST", p, {}, { pageSize: 50, filters: [{ name: "name", type: "String", operator: "IN", values: [name] }] });
  return (r.body.entities ?? []).find((x: Obj) => x.name === name);
}
const post = async (c: GenesysClient, p: string, body: unknown) => (await c.request<Obj>("POST", p, {}, body)).body;
const put = async (c: GenesysClient, p: string, body: unknown) => (await c.request<Obj>("PUT", p, {}, body)).body;
const patch = async (c: GenesysClient, p: string, body: unknown) => (await c.request<Obj>("PATCH", p, {}, body)).body;
const del = async (c: GenesysClient, p: string) => {
  await c.request("DELETE", p);
};

/** Waits for a Genesys job until done(state) says so. */
async function poll<T>(get: () => Promise<T>, done: (x: T) => boolean, what: string, tries = 60, ms = 3000): Promise<T> {
  let x = await get();
  for (let i = 0; i < tries && !done(x); i++) {
    await sleep(ms);
    x = await get();
  }
  if (!done(x)) throw new GctkError("DEMO_TIMEOUT", `${what} did not finish in time.`);
  return x;
}

/** Architect flows travel as YAML: export job in the source, Architect job (validates, publishes) in the target. */
function architectFlow(label: string, flowType: string): TypeDef {
  const byName = (c: GenesysClient, n: string) => firstNamed(c, "/api/v2/flows", n, { name: n, type: flowType });
  // Architect YAML names its division; the target's division replaces the source's.
  const withDivision = (yaml: string, division: string) => yaml.replace(/^(\s*division:\s*).*$/m, `$1${division}`);
  const comparable = (yaml: string) => withDivision(yaml, "-").replace(/\r\n/g, "\n").trim();
  const def: TypeDef = {
    label,
    byName,
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/flows/${id}`)).body,
    // The source's division name stays out of the package; the deploy puts in the target's.
    capture: async (c, r) => ({ name: r.name, divisionId: r.division?.id, spec: { name: r.name, yaml: withDivision(await exportFlowYaml(c, { id: r.id }), "Home") } }),
    find: async (c, n) => (await byName(c, n))?.id,
    // An Architect job with the same flow name publishes a new version of that flow.
    // Architect rewrites some YAML on import (drops empty lists, fills in a bot's slot bindings), so
    // "unchanged" also means: the same snapshot as last time, and the org still exports what it did then.
    refresh: async (id, s, e) => {
      const hash = (y: string) => crypto.createHash("sha256").update(comparable(y)).digest("hex");
      const want = hash(String(s.yaml));
      const now = hash(await exportFlowYaml(e.client, { id }));
      const last = e.refreshed[id];
      if (now === want || (last?.source === want && last.result === now)) return false;
      await def.create(s, e);
      e.refreshed[id] = { source: want, result: hash(await exportFlowYaml(e.client, { id })) };
      return true;
    },
    create: async (s, e) => {
      const c = e.client;
      const yaml = withDivision(String(s.yaml), JSON.stringify(e.division.name));
      const job = await post(c, "/api/v2/flows/jobs", {});
      const url = job.presignedUrl ?? job.url;
      if (!url) throw new GctkError("DEMO_FLOW", "The Architect job returned no upload URL.");
      const up = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/octet-stream", ...(job.headers ?? {}) }, body: yaml });
      if (!up.ok) throw new GctkError("DEMO_FLOW", `Uploading the flow failed with HTTP ${up.status}.`);
      e.log(`  publishing ${s.name} …`);
      const st = await poll(async () => (await c.get<Obj>(`/api/v2/flows/jobs/${job.id}`, { expand: "messages" })).body, (x) => x.status === "Success" || x.status === "Failure", `Deploying ${s.name}`, 60, 3000);
      if (st.status !== "Success") throw new GctkError("DEMO_FLOW", `Deploying ${s.name} failed: ${(st.messages ?? []).map((m: Obj) => m.text).join("; ") || "no details"}`);
      const id = st.flow?.id ?? (await byName(c, s.name))?.id;
      if (!id) throw new GctkError("DEMO_FLOW", `${s.name} was deployed but is not visible yet.`);
      return { id };
    },
    remove: (c, id) => del(c, `/api/v2/flows/${id}`),
  };
  return def;
}

// The order is the deploy order: everything an object points to comes before it.
const TYPES: Record<string, TypeDef> = {
  wrapupcode: {
    label: "Wrap-up code",
    byName: (c, n) => firstNamed(c, "/api/v2/routing/wrapupcodes", n, { name: n }),
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/routing/wrapupcodes/${id}`)).body,
    capture: async (_c, r) => ({ name: r.name, spec: { name: r.name, description: r.description } }),
    find: async (c, n) => (await firstNamed(c, "/api/v2/routing/wrapupcodes", n, { name: n }))?.id,
    create: async (s, e) => ({ id: (await post(e.client, "/api/v2/routing/wrapupcodes", { name: s.name, description: s.description, divisionId: e.division.id })).id }),
    remove: (c, id) => del(c, `/api/v2/routing/wrapupcodes/${id}`),
  },
  responselibrary: {
    label: "Response library",
    byName: (c, n) => firstNamed(c, "/api/v2/responsemanagement/libraries", n),
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/responsemanagement/libraries/${id}`)).body,
    capture: async (c, r) => {
      const responses = await all(c, "/api/v2/responsemanagement/responses", { libraryId: r.id });
      return {
        name: r.name,
        subs: Object.fromEntries(responses.map((x) => [x.id, `response:${x.name}`])),
        spec: { name: r.name, responses: responses.map((x) => ({ name: x.name, texts: x.texts, substitutions: x.substitutions ?? [], ...(x.interactionType ? { interactionType: x.interactionType } : {}), ...(x.responseType ? { responseType: x.responseType } : {}) })) },
      };
    },
    find: async (c, n) => (await firstNamed(c, "/api/v2/responsemanagement/libraries", n))?.id,
    create: async (s, e) => {
      const lib = await post(e.client, "/api/v2/responsemanagement/libraries", { name: s.name });
      const subs: Record<string, string> = {};
      for (const r of s.responses as Obj[]) subs[`response:${r.name}`] = (await post(e.client, "/api/v2/responsemanagement/responses", { ...r, libraries: [{ id: lib.id }] })).id;
      return { id: lib.id, subs };
    },
    subsOf: async (c, id) => Object.fromEntries((await all(c, "/api/v2/responsemanagement/responses", { libraryId: id })).map((x) => [`response:${x.name}`, x.id])),
    remove: async (c, id) => {
      for (const r of await all(c, "/api/v2/responsemanagement/responses", { libraryId: id })) await del(c, `/api/v2/responsemanagement/responses/${r.id}`);
      await del(c, `/api/v2/responsemanagement/libraries/${id}`);
    },
  },
  queue: {
    label: "Queue",
    byName: (c, n) => firstNamed(c, "/api/v2/routing/queues", n, { name: n }),
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/routing/queues/${id}`)).body,
    capture: async (c, r) => {
      const wraps = await all(c, `/api/v2/routing/queues/${r.id}/wrapupcodes`);
      // Which canned response libraries agents see on this queue (SelectedOnly lists them).
      const libs = r.cannedResponseLibraries as { mode?: string; libraryIds?: string[] } | undefined;
      return {
        name: r.name,
        divisionId: r.division?.id,
        deps: [...wraps.map((w) => ({ type: "wrapupcode", id: w.id })), ...(libs?.libraryIds ?? []).map((id) => ({ type: "responselibrary", id }))],
        spec: { name: r.name, description: r.description, mediaSettings: r.mediaSettings, acwSettings: r.acwSettings, skillEvaluationMethod: r.skillEvaluationMethod, enableTranscription: r.enableTranscription, ...(libs?.mode ? { cannedResponseLibraries: { mode: libs.mode, ...(libs.libraryIds?.length ? { libraryIds: libs.libraryIds } : {}) } } : {}), wrapupCodes: wraps.map((w) => w.id) },
      };
    },
    find: async (c, n) => (await firstNamed(c, "/api/v2/routing/queues", n, { name: n }))?.id,
    refresh: async (id, s, e) => {
      if (!s.cannedResponseLibraries) return false;
      const cur = (await e.client.get<Obj>(`/api/v2/routing/queues/${id}`)).body;
      const norm = (x: Obj | undefined) => JSON.stringify({ mode: x?.mode ?? "All", libraryIds: [...(x?.libraryIds ?? [])].sort() });
      if (norm(cur.cannedResponseLibraries) === norm(s.cannedResponseLibraries)) return false;
      await put(e.client, `/api/v2/routing/queues/${id}`, { ...strip(cur, "selfUri", "dateCreated", "dateModified", "modifiedBy", "createdBy", "memberCount", "userMemberCount", "joinedMemberCount", "division"), cannedResponseLibraries: s.cannedResponseLibraries });
      return true;
    },
    create: async (s, e) => {
      const q = await post(e.client, "/api/v2/routing/queues", { ...strip(s, "wrapupCodes"), divisionId: e.division.id });
      if (s.wrapupCodes?.length) await post(e.client, `/api/v2/routing/queues/${q.id}/wrapupcodes`, s.wrapupCodes.map((id: string) => ({ id })));
      if (e.presenter) await post(e.client, `/api/v2/routing/queues/${q.id}/members`, [{ id: e.presenter }]);
      return { id: q.id };
    },
    remove: (c, id) => del(c, `/api/v2/routing/queues/${id}`),
  },
  intentcategory: {
    label: "Intent category",
    byName: (c, n) => firstNamed(c, "/api/v2/intents/categories", n),
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/intents/categories/${id}`)).body,
    capture: async (_c, r) => ({ name: r.name, spec: { name: r.name, description: r.description || r.name } }),
    find: async (c, n) => (await firstNamed(c, "/api/v2/intents/categories", n))?.id,
    create: async (s, e) => ({ id: (await post(e.client, "/api/v2/intents/categories", s)).id }),
    remove: (c, id) => del(c, `/api/v2/intents/categories/${id}`),
  },
  customerintent: {
    label: "Customer intent",
    byName: (c, n) => firstNamed(c, "/api/v2/intents/customerintents", n),
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/intents/customerintents/${id}`)).body,
    capture: async (_c, r) => ({ name: r.name, deps: r.category?.id ? [{ type: "intentcategory", id: r.category.id }] : [], spec: { name: r.name, description: r.description || r.name, expiryTime: r.expiryTime ?? 720, categoryId: r.category?.id } }),
    find: async (c, n) => (await firstNamed(c, "/api/v2/intents/customerintents", n))?.id,
    create: async (s, e) => ({ id: (await post(e.client, "/api/v2/intents/customerintents", s)).id }),
    remove: (c, id) => del(c, `/api/v2/intents/customerintents/${id}`),
  },
  workbin: {
    label: "Workbin",
    byName: (c, n) => queryNamed(c, "/api/v2/taskmanagement/workbins/query", n),
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/taskmanagement/workbins/${id}`)).body,
    capture: async (_c, r) => ({ name: r.name, divisionId: r.division?.id, spec: { name: r.name, description: r.description } }),
    find: async (c, n) => (await queryNamed(c, "/api/v2/taskmanagement/workbins/query", n))?.id,
    create: async (s, e) => ({ id: (await post(e.client, "/api/v2/taskmanagement/workbins", { ...s, divisionId: e.division.id })).id }),
    remove: (c, id) => del(c, `/api/v2/taskmanagement/workbins/${id}`),
  },
  workitemschema: {
    label: "Work item schema",
    byName: (c, n) => firstNamed(c, "/api/v2/taskmanagement/workitems/schemas", n),
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/taskmanagement/workitems/schemas/${id}`)).body,
    capture: async (_c, r) => ({ name: r.name, spec: { name: r.name, appliesTo: r.appliesTo ?? ["WORKITEM"], enabled: r.enabled ?? true, jsonSchema: r.jsonSchema } }),
    find: async (c, n) => (await firstNamed(c, "/api/v2/taskmanagement/workitems/schemas", n))?.id,
    create: async (s, e) => ({ id: (await post(e.client, "/api/v2/taskmanagement/workitems/schemas", s)).id }),
    remove: (c, id) => del(c, `/api/v2/taskmanagement/workitems/schemas/${id}`),
  },
  worktype: {
    label: "Worktype",
    byName: (c, n) => queryNamed(c, "/api/v2/taskmanagement/worktypes/query", n),
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/taskmanagement/worktypes/${id}`)).body,
    capture: async (_c, r) => {
      const nameOf = new Map((r.statuses ?? []).map((s: Obj) => [s.id, s.name]));
      const deps = [
        ...(r.defaultWorkbin?.id ? [{ type: "workbin", id: r.defaultWorkbin.id }] : []),
        ...(r.schema?.id ? [{ type: "workitemschema", id: r.schema.id }] : []),
        ...(r.defaultQueue?.id ? [{ type: "queue", id: r.defaultQueue.id }] : []),
      ];
      return {
        name: r.name,
        divisionId: r.division?.id,
        deps,
        spec: {
          name: r.name,
          description: r.description,
          defaultWorkbinId: r.defaultWorkbin?.id,
          ...(r.schema?.id ? { schemaId: r.schema.id } : {}),
          ...(r.defaultQueue?.id ? { defaultQueueId: r.defaultQueue.id } : {}),
          ...Object.fromEntries(["defaultDurationSeconds", "defaultExpirationSeconds", "defaultDueDurationSeconds", "defaultPriority", "defaultTtlSeconds", "assignmentEnabled", "serviceLevelTarget"].filter((k) => r[k] !== undefined && r[k] !== null).map((k) => [k, r[k]])),
          statuses: (r.statuses ?? []).map((s: Obj) => ({
            name: s.name,
            category: s.category,
            description: s.description,
            destinations: (s.destinationStatuses ?? []).map((d: Obj) => nameOf.get(d.id)).filter(Boolean),
            defaultDestination: s.defaultDestinationStatus?.id ? nameOf.get(s.defaultDestinationStatus.id) : undefined,
            statusTransitionDelaySeconds: s.statusTransitionDelaySeconds,
            autoTerminateWorkitem: s.autoTerminateWorkitem,
          })),
          defaultStatus: r.defaultStatus?.id ? nameOf.get(r.defaultStatus.id) : undefined,
        },
      };
    },
    find: async (c, n) => (await queryNamed(c, "/api/v2/taskmanagement/worktypes/query", n))?.id,
    create: async (s, e) => {
      const { statuses, defaultStatus, ...body } = s;
      const wt = await post(e.client, "/api/v2/taskmanagement/worktypes", { ...body, divisionId: e.division.id, disableDefaultStatusCreation: true });
      const ids = new Map<string, string>();
      for (const st of statuses as Obj[]) {
        const created = await post(e.client, `/api/v2/taskmanagement/worktypes/${wt.id}/statuses`, { name: st.name, category: st.category, ...(st.description ? { description: st.description } : {}), ...(st.statusTransitionDelaySeconds ? { statusTransitionDelaySeconds: st.statusTransitionDelaySeconds } : {}), ...(st.autoTerminateWorkitem ? { autoTerminateWorkitem: true } : {}) });
        ids.set(st.name, created.id);
      }
      for (const st of statuses as Obj[]) {
        if (!st.destinations.length && !st.defaultDestination) continue;
        await patch(e.client, `/api/v2/taskmanagement/worktypes/${wt.id}/statuses/${ids.get(st.name)}`, { destinationStatusIds: st.destinations.map((n: string) => ids.get(n)), ...(st.defaultDestination ? { defaultDestinationStatusId: ids.get(st.defaultDestination) } : {}) });
      }
      if (defaultStatus && ids.get(defaultStatus)) await patch(e.client, `/api/v2/taskmanagement/worktypes/${wt.id}`, { defaultStatusId: ids.get(defaultStatus) });
      return { id: wt.id };
    },
    remove: (c, id) => del(c, `/api/v2/taskmanagement/worktypes/${id}`),
  },
  caseplan: {
    label: "Case plan",
    byName: (c, n) => firstNamed(c, "/api/v2/casemanagement/caseplans", n),
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/casemanagement/caseplans/${id}`)).body,
    capture: async (c, r) => {
      const v = r.published ?? r.latest;
      const base = `/api/v2/casemanagement/caseplans/${r.id}/versions/${v}`;
      const stages = await all(c, `${base}/stageplans`);
      const steps = await Promise.all(stages.map((s) => all(c, `${base}/stageplans/${s.id}/stepplans`)));
      const schemas = await all(c, `${base}/dataschemas`);
      const intake = await all(c, `${base}/intakesettings`);
      const worktypes = steps.flat().map((s) => s.workitemSettings?.worktype?.id).filter(Boolean);
      return {
        name: r.name,
        divisionId: r.division?.id,
        deps: [...(r.customerIntent?.id ? [{ type: "customerintent", id: r.customerIntent.id }] : []), ...schemas.map((s) => ({ type: "workitemschema", id: s.id })), ...worktypes.map((id) => ({ type: "worktype", id }))],
        spec: {
          name: r.name,
          description: r.description,
          referencePrefix: r.referencePrefix,
          defaultDueDurationInSeconds: r.defaultDueDurationInSeconds,
          defaultTtlSeconds: r.defaultTtlSeconds,
          customerIntentId: r.customerIntent?.id,
          dataSchemas: schemas.map((s) => s.id),
          intakeSettings: intake.map((i) => strip(i, "selfUri")),
          stages: stages.map((s, i) => ({ name: s.name, description: s.description, steps: steps[i]!.map((st) => ({ name: st.name, description: st.description, activityType: st.activityType, ...(st.workitemSettings?.worktype?.id ? { worktypeId: st.workitemSettings.worktype.id } : {}) })) })),
        },
      };
    },
    find: async (c, n) => (await firstNamed(c, "/api/v2/casemanagement/caseplans", n))?.id,
    create: async (s, e) => {
      const c = e.client;
      // Data schemas are referenced with their current version in the target.
      const dataSchemas = await Promise.all((s.dataSchemas as string[]).map(async (id) => ({ id, version: (await c.get<Obj>(`/api/v2/taskmanagement/workitems/schemas/${id}`)).body.version ?? 1 })));
      const plan = await post(c, "/api/v2/casemanagement/caseplans", { name: s.name, description: s.description, referencePrefix: s.referencePrefix, defaultDueDurationInSeconds: s.defaultDueDurationInSeconds, defaultTtlSeconds: s.defaultTtlSeconds, customerIntentId: s.customerIntentId, divisionId: e.division.id, dataSchemas, intakeSettings: s.intakeSettings });
      const v = plan.latest ?? 1;
      const base = `/api/v2/casemanagement/caseplans/${plan.id}`;
      const stages = await all(c, `${base}/versions/${v}/stageplans`);
      for (const [i, st] of (s.stages as Obj[]).entries()) {
        const target = stages[i];
        if (!target) {
          e.log(`  ! ${s.name}: the new plan has ${stages.length} stages, the demo ${s.stages.length}; stage "${st.name}" was left out.`);
          continue;
        }
        await patch(c, `${base}/stageplans/${target.id}`, { name: st.name, description: st.description });
        const steps = await all(c, `${base}/versions/${v}/stageplans/${target.id}/stepplans`);
        for (const [j, sp] of (st.steps as Obj[]).entries()) {
          if (!steps[j]) continue;
          await patch(c, `${base}/stageplans/${target.id}/stepplans/${steps[j]!.id}`, { name: sp.name, description: sp.description, activityType: sp.activityType, ...(sp.worktypeId ? { workitemSettings: { worktypeId: sp.worktypeId } } : {}) });
        }
      }
      await post(c, `${base}/publish`, {});
      return { id: plan.id };
    },
    remove: (c, id) => del(c, `/api/v2/casemanagement/caseplans/${id}`),
  },
  externalcontact: {
    label: "External contact",
    byName: async (c, n) => (await all(c, "/api/v2/externalcontacts/contacts", { q: n })).find((x) => `${x.firstName} ${x.lastName}` === n),
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/externalcontacts/contacts/${id}`)).body,
    capture: async (_c, r) => ({ name: `${r.firstName} ${r.lastName}`, spec: Object.fromEntries(["firstName", "lastName", "salutation", "title", "workPhone", "cellPhone", "homePhone", "workEmail", "personalEmail", "address", "whatsAppId"].filter((k) => r[k] !== undefined).map((k) => [k, k.endsWith("Phone") ? strip(r[k], "e164", "countryCode", "userInput") : r[k]])) }),
    find: async (c, n) => (await all(c, "/api/v2/externalcontacts/contacts", { q: n })).find((x) => `${x.firstName} ${x.lastName}` === n)?.id,
    create: async (s, e) => ({ id: (await post(e.client, "/api/v2/externalcontacts/contacts", s)).id }),
    update: async (c, id, s) => {
      const cur = (await c.get<Obj>(`/api/v2/externalcontacts/contacts/${id}`)).body;
      await put(c, `/api/v2/externalcontacts/contacts/${id}`, { ...cur, ...s });
    },
    remove: (c, id) => del(c, `/api/v2/externalcontacts/contacts/${id}`),
  },
  knowledgebase: {
    label: "Knowledge base",
    byName: (c, n) => firstNamed(c, "/api/v2/knowledge/knowledgebases", n),
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/knowledge/knowledgebases/${id}`)).body,
    capture: async (c, r) => {
      const cats = await all(c, `/api/v2/knowledge/knowledgebases/${r.id}/categories`);
      const catName = new Map(cats.map((x) => [x.id, x.name]));
      const docs = await all(c, `/api/v2/knowledge/knowledgebases/${r.id}/documents`, { expand: "category" });
      const documents = [];
      for (const d of docs) {
        const variations = await all(c, `/api/v2/knowledge/knowledgebases/${r.id}/documents/${d.id}/variations`);
        documents.push({ title: d.title, visible: d.visible, alternatives: d.alternatives, category: d.category?.id ? catName.get(d.category.id) : undefined, variations: variations.map((v) => ({ name: v.name, priority: v.priority, contexts: v.contexts ?? [], body: v.body })) });
      }
      return {
        name: r.name,
        spec: { name: r.name, description: r.description, coreLanguage: r.coreLanguage, contentSearchEnabled: r.contentSearchEnabled, categories: cats.map((x) => ({ name: x.name, description: x.description, parent: x.parentCategory?.id ? catName.get(x.parentCategory.id) : undefined })), documents },
      };
    },
    find: async (c, n) => (await firstNamed(c, "/api/v2/knowledge/knowledgebases", n))?.id,
    create: async (s, e) => {
      const c = e.client;
      const kb = await post(c, "/api/v2/knowledge/knowledgebases", { name: s.name, description: s.description, coreLanguage: s.coreLanguage, contentSearchEnabled: s.contentSearchEnabled ?? true });
      const cat = new Map<string, string>();
      const pending = [...(s.categories as Obj[])];
      for (let round = 0; pending.length && round < 5; round++) {
        for (const x of [...pending]) {
          if (x.parent && !cat.has(x.parent)) continue;
          cat.set(x.name, (await post(c, `/api/v2/knowledge/knowledgebases/${kb.id}/categories`, { name: x.name, description: x.description, ...(x.parent ? { parentCategoryId: cat.get(x.parent) } : {}) })).id);
          pending.splice(pending.indexOf(x), 1);
        }
      }
      for (const d of s.documents as Obj[]) {
        const doc = await post(c, `/api/v2/knowledge/knowledgebases/${kb.id}/documents`, { title: d.title, visible: d.visible, alternatives: d.alternatives, ...(d.category && cat.get(d.category) ? { categoryId: cat.get(d.category) } : {}) });
        for (const v of d.variations as Obj[]) await post(c, `/api/v2/knowledge/knowledgebases/${kb.id}/documents/${doc.id}/variations`, v);
        await post(c, `/api/v2/knowledge/knowledgebases/${kb.id}/documents/${doc.id}/versions`, {});
      }
      return { id: kb.id };
    },
    remove: (c, id) => del(c, `/api/v2/knowledge/knowledgebases/${id}`),
  },
  agentchecklist: {
    label: "Agent checklist",
    byName: (c, n) => firstNamed(c, "/api/v2/assistants/agentchecklists", n),
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/assistants/agentchecklists/${id}`)).body,
    capture: async (_c, r) => ({ name: r.name, spec: { name: r.name, language: r.language, checklistItems: (r.checklistItems ?? []).map((i: Obj) => strip(i, "id")) } }),
    find: async (c, n) => (await firstNamed(c, "/api/v2/assistants/agentchecklists", n))?.id,
    create: async (s, e) => ({ id: (await post(e.client, "/api/v2/assistants/agentchecklists", s)).id }),
    remove: (c, id) => del(c, `/api/v2/assistants/agentchecklists/${id}`),
  },
  nludomain: {
    label: "NLU domain",
    byName: (c, n) => firstNamed(c, "/api/v2/languageunderstanding/domains", n),
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/languageunderstanding/domains/${id}`)).body,
    capture: async (c, r) => {
      const versions = await all(c, `/api/v2/languageunderstanding/domains/${r.id}/versions`);
      const pub = versions.find((v) => v.published) ?? versions[0];
      const full = pub ? (await c.get<Obj>(`/api/v2/languageunderstanding/domains/${r.id}/versions/${pub.id}`, { includeUtterances: true })).body : {};
      const clean = (x: unknown): unknown => (Array.isArray(x) ? x.map(clean) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x as Obj).filter(([k]) => k !== "id" && k !== "selfUri").map(([k, v]) => [k, clean(v)])) : x);
      return { name: r.name, spec: { name: r.name, language: r.language ?? full.language, version: { language: full.language ?? r.language, intents: clean(full.intents ?? []), entityTypes: clean(full.entityTypes ?? []), entities: clean(full.entities ?? []) } } };
    },
    find: async (c, n) => (await firstNamed(c, "/api/v2/languageunderstanding/domains", n))?.id,
    create: async (s, e) => {
      const c = e.client;
      const d = await post(c, "/api/v2/languageunderstanding/domains", { name: s.name, language: s.language });
      const v = await post(c, `/api/v2/languageunderstanding/domains/${d.id}/versions`, s.version);
      await post(c, `/api/v2/languageunderstanding/domains/${d.id}/versions/${v.id}/train`, {});
      e.log(`  training ${s.name} …`);
      const t = await poll(async () => (await c.get<Obj>(`/api/v2/languageunderstanding/domains/${d.id}/versions/${v.id}`)).body, (x) => ["Trained", "Failed", "Error"].includes(x.trainingStatus), `Training ${s.name}`, 40, 6000);
      if (t.trainingStatus !== "Trained") throw new GctkError("DEMO_NLU", `Training ${s.name} ended with ${t.trainingStatus}.`);
      await post(c, `/api/v2/languageunderstanding/domains/${d.id}/versions/${v.id}/publish`, {});
      return { id: d.id };
    },
    remove: (c, id) => del(c, `/api/v2/languageunderstanding/domains/${id}`),
  },
  script: {
    label: "Agent script",
    byName: (c, n) => firstNamed(c, "/api/v2/scripts", n, { name: n }),
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/scripts/${id}`)).body,
    capture: async (c, r) => {
      const pages = (await c.get<Obj>(`/api/v2/scripts/${r.id}/pages`)).body;
      const list = (Array.isArray(pages) ? pages : (pages.entities ?? [])) as Obj[];
      const full = await Promise.all(list.map(async (p) => (await c.get<Obj>(`/api/v2/scripts/${r.id}/pages/${p.id}`)).body));
      // Page ids are chosen by the client and stay the same, so references to pages need no mapping.
      return { name: r.name, keep: full.map((p) => p.id), spec: { name: r.name, features: r.features, variables: r.variables, customActions: r.customActions, startPageId: r.startPageId, pages: full.map((p) => ({ id: p.id, name: p.name, properties: p.properties, rootContainer: p.rootContainer })) } };
    },
    find: async (c, n) => (await firstNamed(c, "/api/v2/scripts", n, { name: n }))?.id,
    create: async (s, e) => {
      const c = e.client;
      const { pages, ...settings } = s;
      const sc = await post(c, "/api/v2/scripts", { ...settings, divisionId: e.division.id });
      const existing = (await c.get<Obj>(`/api/v2/scripts/${sc.id}/pages`)).body;
      const have = new Map(((Array.isArray(existing) ? existing : (existing.entities ?? [])) as Obj[]).map((p) => [p.id, p]));
      for (const p of pages as Obj[]) {
        if (have.has(p.id)) await put(c, `/api/v2/scripts/${sc.id}/pages/${p.id}`, { ...have.get(p.id), ...p });
        else await post(c, `/api/v2/scripts/${sc.id}/pages`, { ...p, dataVersion: 0 });
      }
      await post(c, "/api/v2/scripts/published", { scriptId: sc.id });
      return { id: sc.id };
    },
    remove: (c, id) => del(c, `/api/v2/scripts/${id}`),
  },
  assistant: {
    label: "Copilot assistant",
    byName: (c, n) => firstNamed(c, "/api/v2/assistants", n),
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/assistants/${id}`)).body,
    capture: async (c, r) => {
      const copilot = strip((await c.get<Obj>(`/api/v2/assistants/${r.id}/copilot`)).body, "selfUri");
      const queues = await all(c, `/api/v2/assistants/${r.id}/queues`);
      return { name: r.name, spec: { name: r.name, transcriptionConfig: r.transcriptionConfig, knowledgeSuggestionConfig: r.knowledgeSuggestionConfig, copilot, queues: queues.map((q) => ({ id: q.id, mediaTypes: q.mediaTypes, assignmentMode: q.assignmentMode })) } };
    },
    find: async (c, n) => (await firstNamed(c, "/api/v2/assistants", n))?.id,
    create: async (s, e) => {
      const c = e.client;
      const a = await post(c, "/api/v2/assistants", { name: s.name, transcriptionConfig: s.transcriptionConfig, knowledgeSuggestionConfig: s.knowledgeSuggestionConfig });
      await put(c, `/api/v2/assistants/${a.id}/copilot`, s.copilot);
      for (const q of s.queues as Obj[]) await put(c, `/api/v2/assistants/${a.id}/queues/${q.id}`, { id: q.id, mediaTypes: q.mediaTypes, assignmentMode: q.assignmentMode });
      return { id: a.id };
    },
    remove: (c, id) => del(c, `/api/v2/assistants/${id}`),
  },
  statopic: {
    label: "Speech & text analytics topic",
    byName: (c, n) => firstNamed(c, "/api/v2/speechandtextanalytics/topics", n),
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/speechandtextanalytics/topics/${id}`)).body,
    capture: async (_c, r) => ({ name: r.name, spec: { name: r.name, description: r.description, strictness: String(r.strictness ?? "72"), matchingType: r.matchingType, dialect: r.dialect, participants: r.participants, tags: r.tags ?? [], phrases: (r.phrases ?? []).map((p: Obj) => ({ text: p.text, strictness: p.strictness, sentiment: p.sentiment })) } }),
    find: async (c, n) => (await firstNamed(c, "/api/v2/speechandtextanalytics/topics", n))?.id,
    create: async (s, e) => {
      const t = await post(e.client, "/api/v2/speechandtextanalytics/topics", s);
      await post(e.client, "/api/v2/speechandtextanalytics/topics/publishjobs", { topicIds: [t.id] });
      return { id: t.id };
    },
    remove: (c, id) => del(c, `/api/v2/speechandtextanalytics/topics/${id}`),
  },
  staprogram: {
    label: "Speech & text analytics program",
    byName: (c, n) => firstNamed(c, "/api/v2/speechandtextanalytics/programs", n),
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/speechandtextanalytics/programs/${id}`)).body,
    capture: async (c, r) => {
      const m = (await c.get<Obj>(`/api/v2/speechandtextanalytics/programs/${r.id}/mappings`)).body;
      const topics = (r.topics ?? []).map((t: Obj) => t.id);
      return { name: r.name, deps: topics.map((id: string) => ({ type: "statopic", id })), spec: { name: r.name, description: r.description, tags: r.tags ?? [], topicIds: topics, queueIds: (m.queues ?? []).map((q: Obj) => q.id), flowIds: [] } };
    },
    find: async (c, n) => (await firstNamed(c, "/api/v2/speechandtextanalytics/programs", n))?.id,
    create: async (s, e) => {
      const p = await post(e.client, "/api/v2/speechandtextanalytics/programs", { name: s.name, description: s.description, tags: s.tags, topicIds: s.topicIds });
      await put(e.client, `/api/v2/speechandtextanalytics/programs/${p.id}/mappings`, { queueIds: s.queueIds, flowIds: [] });
      await post(e.client, "/api/v2/speechandtextanalytics/programs/publishjobs", { programIds: [p.id] });
      return { id: p.id };
    },
    remove: (c, id) => del(c, `/api/v2/speechandtextanalytics/programs/${id}`),
  },
  botflow: architectFlow("Digital bot flow", "digitalbot"),
  messageflow: architectFlow("Inbound message flow", "inboundshortmessage"),
  messengerconfig: {
    label: "Messenger configuration",
    byName: (c, n) => firstNamed(c, "/api/v2/webdeployments/configurations", n),
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/webdeployments/configurations/${id}/versions/draft`)).body,
    capture: async (_c, r) => ({ name: r.name, spec: strip(r, "id", "version", "status", "selfUri", "dateCreated", "dateModified", "datePublished", "lastModifiedUser", "createdUser", "publishedUser") }),
    find: async (c, n) => (await firstNamed(c, "/api/v2/webdeployments/configurations", n))?.id,
    // A configuration is a draft until published; deployments point to a published version.
    create: async (s, e) => {
      const cfg = await post(e.client, "/api/v2/webdeployments/configurations", s);
      await post(e.client, `/api/v2/webdeployments/configurations/${cfg.id}/versions/draft/publish`, {});
      return { id: cfg.id };
    },
    remove: (c, id) => del(c, `/api/v2/webdeployments/configurations/${id}`),
  },
  messengerdeployment: {
    label: "Messenger deployment",
    byName: (c, n) => firstNamed(c, "/api/v2/webdeployments/deployments", n),
    byId: async (c, id) => (await c.get<Obj>(`/api/v2/webdeployments/deployments/${id}`)).body,
    capture: async (_c, r) => ({ name: r.name, spec: { name: r.name, description: r.description, allowAllDomains: r.allowAllDomains, allowedDomains: r.allowedDomains, configurationId: r.configuration?.id, flowId: r.flow?.id } }),
    find: async (c, n) => (await firstNamed(c, "/api/v2/webdeployments/deployments", n))?.id,
    create: async (s, e) => {
      const c = e.client;
      const versions = (await c.get<Obj>(`/api/v2/webdeployments/configurations/${s.configurationId}/versions`)).body.entities as Obj[];
      const version = versions.map((v) => String(v.version)).filter((v) => /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a))[0];
      if (!version) throw new GctkError("DEMO_MESSENGER", "The messenger configuration has no published version.");
      const dep = await post(c, "/api/v2/webdeployments/deployments", { name: s.name, description: s.description, allowAllDomains: s.allowAllDomains ?? false, allowedDomains: s.allowedDomains ?? [], configuration: { id: s.configurationId, version }, ...(s.flowId ? { flow: { id: s.flowId } } : {}) });
      e.log(`  waiting until ${s.name} is active …`);
      const st = await poll(async () => (await c.get<Obj>(`/api/v2/webdeployments/deployments/${dep.id}`)).body, (x) => x.status === "Active" || x.status === "Error", `Activating ${s.name}`, 40, 3000);
      if (st.status !== "Active") throw new GctkError("DEMO_MESSENGER", `The messenger deployment ${s.name} ended in status ${st.status}.`);
      return { id: dep.id };
    },
    remove: (c, id) => del(c, `/api/v2/webdeployments/deployments/${id}`),
  },
};
const ORDER = Object.keys(TYPES);
export const DEMO_TYPES = Object.fromEntries(ORDER.map((t) => [t, TYPES[t]!.label]));

const token = (type: string, name: string, sub?: string) => `@{${type}:${name}${sub ? `#${sub}` : ""}}`;

export interface DemoStory {
  summary?: string;
  persona?: string;
  duration?: string;
  rules?: string[];
  before?: string[];
  scenes: Array<{ title: string; duration?: string; screen?: string; steps?: Array<{ who: string; text: string; channel?: string }>; triggers?: Array<{ when: string; then: string }>; notes?: string[] }>;
  reference: {
    copilot: Array<{ when: string; then: string[] }>;
    intents: Array<{ name: string; rule: boolean; phrases: string[] }>;
    checklists: Array<{ name: string; items: Array<{ name: string; ticksWhen: string }> }>;
    topics: Array<{ name: string; phrases: string[] }>;
  };
}

/** The package's story.yaml (if any) and what triggers what, read from the snapshot's Copilot, NLU, checklists and topics. */
export function loadStory(pkg: string, m: DemoManifest, snap?: Snapshot): DemoStory | undefined {
  const file = path.join(pkg, "story.yaml");
  if (!fs.existsSync(file)) return undefined;
  const story = YAML.parse(fs.readFileSync(file, "utf8")) as Omit<DemoStory, "reference">;
  const objs = snap?.objects ?? [];
  const tokenName = (tok: unknown) => String(tok ?? "").replace(/^@\{[^:]+:/, "").replace(/\}$/, "");
  const sub = (tok: unknown) => String(tok ?? "").match(/#[^:]+:(.+)\}$/)?.[1] ?? tokenName(tok);
  const pageName = (scriptTok: unknown, pageId: unknown) => objs.find((o) => o.type === "script" && o.name === tokenName(scriptTok))?.spec.pages?.find((p: Obj) => p.id === pageId)?.name;
  const action = (a: Obj): string => {
    const at = a.attributes ?? {};
    if (a.actionType === "CannedResponse") return `Canned response „${sub(at.responseId)}“`;
    if (a.actionType === "Checklist") return `Checklist „${tokenName(at.checklistId)}“`;
    if (a.actionType === "Script") return `Script page „${pageName(at.scriptId, at.pageId) ?? at.pageId}“ of „${tokenName(at.scriptId)}“`;
    if (a.actionType === "ThirdPartyAction") return m.local?.copilot ? `Third-party answer from gctk: „${m.local.copilot.title}“ (needs Start on the Demos page)` : "Third-party action";
    if (a.actionType === "KnowledgeSearch") return "Knowledge search with a generated answer";
    return String(a.actionType);
  };
  const copilotSpec = objs.find((o) => o.type === "assistant")?.spec.copilot as Obj | undefined;
  const nlu = objs.find((o) => o.type === "nludomain")?.spec.version as Obj | undefined;
  const intentNames = new Set<string>(((nlu?.intents ?? []) as Obj[]).map((i) => i.name));
  const ruleIntents = new Set<string>();
  const copilot: DemoStory["reference"]["copilot"] = [];
  for (const r of ((copilotSpec?.ruleEngineConfig?.rules ?? []) as Obj[]).filter((x) => x.enabled !== false)) {
    const who = (r.participantRoles as string[] | undefined)?.join("/");
    const cond = ((r.rule?.conditions ?? []) as Obj[]).map((c) => {
      if (c.conditionType === "ConversationStart") return "The conversation starts (agent accepts)";
      if (c.conditionType === "Intent") {
        for (const v of c.conditionValues ?? []) ruleIntents.add(v);
        const missing = (c.conditionValues as string[]).filter((v) => !intentNames.has(v));
        return `${who ? `${who} message with ` : ""}intent „${(c.conditionValues as string[]).join("“ or „")}“${missing.length ? " (not in the NLU domain, so this rule never fires)" : ""}`;
      }
      return String(c.conditionType);
    });
    copilot.push({ when: cond.join(" and "), then: ((r.rule?.actions ?? []) as Obj[]).map(action) });
  }
  const fb = copilotSpec?.ruleEngineConfig?.fallback as Obj | undefined;
  if (fb?.enabled) copilot.push({ when: `Any other ${(fb.participantRoles ?? []).join("/").toLowerCase() || ""} message (no rule matches)`, then: ((fb.actions ?? []) as Obj[]).map(action) });
  if (copilotSpec?.summaryGenerationConfig?.enabled) copilot.push({ when: "During and after the conversation", then: ["Summary", ...(copilotSpec.wrapupCodePredictionConfig?.enabled ? ["Wrap-up code prediction"] : [])] });
  const text = (u: Obj) => ((u.segments ?? []) as Obj[]).map((s) => s.text).join("");
  return {
    ...story,
    scenes: story.scenes ?? [],
    reference: {
      copilot,
      intents: ((nlu?.intents ?? []) as Obj[]).map((i) => ({ name: i.name, rule: ruleIntents.has(i.name), phrases: ((i.utterances ?? []) as Obj[]).map(text) })),
      checklists: objs.filter((o) => o.type === "agentchecklist").map((c) => ({ name: c.name, items: ((c.spec.checklistItems ?? []) as Obj[]).map((i) => ({ name: i.name, ticksWhen: i.description ?? "" })) })),
      topics: objs.filter((o) => o.type === "statopic").map((tp) => ({ name: tp.name, phrases: ((tp.spec.phrases ?? []) as Obj[]).map((p) => p.text) })),
    },
  };
}

/** The permissions a demo needs: deploy and remove (all channels, then per channel) and what runs during the demo. */
export function demoPermissions(m: DemoManifest, snap?: { objects: Array<{ type: string }> }): Array<{ title: string; items: string[] }> {
  const of = (part: string) => DEMO_PERMISSIONS[part] ?? [];
  const forType = (t: string) => (t === "botflow" || t === "messageflow" ? of("flow") : of(t));
  const set = (parts: string[][]) => [...new Set(parts.flat())].sort();
  const label = (id: string) => m.channels?.find((c) => c.id === id)?.label ?? id;
  const groups: Array<{ title: string; items: string[] }> = [];
  const common = [...(snap?.objects ?? []).map((o) => o.type), ...(m.create ?? []).filter((x) => !x.channel).map((x) => x.type)];
  groups.push({ title: "Deploy and remove", items: set([of("base"), ...[...new Set(common)].map(forType)]) });
  const channelIds = [...new Set([...(m.create ?? []).map((x) => x.channel), m.messageRouting?.channel].filter((x): x is string => Boolean(x)))];
  for (const ch of channelIds) {
    const items = set([...(m.create ?? []).filter((x) => x.channel === ch).map((x) => forType(x.type)), m.messageRouting?.channel === ch ? of("whatsapp") : []]);
    if (items.length) groups.push({ title: `Only for the channel "${label(ch)}"`, items });
  }
  if (m.messageRouting && !m.messageRouting.channel) groups[0]!.items = set([groups[0]!.items, of("whatsapp")]);
  const local = m.local;
  if (local) {
    const items = set([
      ...(local.web?.endpoints ?? []).map((e) => (e.kind === "request" ? of(`local:request:${e.call.path}`) : e.kind === "latestEmail" ? of("local:latestEmail") : [])),
      local.copilot ? of("local:copilot") : [],
    ]);
    if (items.length) groups.push({ title: `During the demo (${local.label})`, items });
  }
  return groups;
}

/** Puts the parameters into the contact fields they stand for, so the snapshot carries no one's phone or email. */
export function applyParameters(objects: SnapObject[], params: DemoParameter[]): void {
  for (const p of params) {
    if (!p.contact) continue;
    const c = objects.find((o) => o.type === "externalcontact" && o.name === p.contact!.name);
    if (!c) continue;
    for (const f of p.contact.fields) {
      if (f === "whatsAppId") c.spec.whatsAppId = { ...(c.spec.whatsAppId ?? {}), phoneNumber: { display: `@{param:${p.id}.digits}`, userInput: `@{param:${p.id}.digits}`, acceptsSMS: false } };
      // Genesys keeps a contact's phone only when it comes as display (userInput alone is dropped).
      else if (/Phone$/.test(f)) c.spec[f] = { ...strip(c.spec[f] ?? {}, "e164", "userInput", "countryCode"), display: `@{param:${p.id}}` };
      else c.spec[f] = `@{param:${p.id}}`;
    }
  }
}

/** Reads the demo's objects (and what they need) from the source org into snapshot.json. */
export async function takeSnapshot(id: string, opts: { client?: GenesysClient; log?: (l: string) => void } = {}): Promise<Snapshot> {
  const src = sourceOf(id);
  const m = loadManifest(src.pkg);
  const source = snapshotSource(id);
  if (!source) throw invalid(`No snapshot source is set for ${id} on this computer.`);
  const profile = loadProfile(source.profile);
  const c = opts.client ?? new GenesysClient(profile, { source: "ui" });
  const log = opts.log ?? (() => {});
  const got = new Map<string, { type: string; raw: Obj; cap: Captured }>();
  const queue: Array<{ type: string; id?: string; name?: string }> = m.include.flatMap((i) => i.names.map((name) => ({ type: i.type, name })));
  while (queue.length) {
    const next = queue.shift()!;
    const def = TYPES[next.type]!;
    const hit = next.id ? { id: next.id } : await def.byName(c, next.name!);
    if (!hit) throw invalid(`${def.label} "${next.name}" was not found in ${source.profile}.`);
    // List entries are short (no topics, media settings …): always read the whole object.
    const raw = await def.byId(c, hit.id);
    if (got.has(raw.id)) continue;
    log(`read ${def.label} "${raw.name ?? next.name}"`);
    const cap = await def.capture(c, raw);
    got.set(raw.id, { type: next.type, raw, cap });
    for (const d of cap.deps ?? []) if (!got.has(d.id)) queue.push({ type: d.type, id: d.id });
  }
  // Every id of a captured object (and of its sub-objects) becomes a token.
  const map = new Map<string, string>();
  for (const [srcId, g] of got) {
    map.set(srcId, token(g.type, g.cap.name));
    for (const [subId, key] of Object.entries(g.cap.subs ?? {})) map.set(subId, token(g.type, g.cap.name, key));
  }
  const divisions = new Set<string>();
  for (const g of got.values()) if (g.cap.divisionId) divisions.add(g.cap.divisionId);
  const keep = new Set([...got.values()].flatMap((g) => g.cap.keep ?? []));
  const objects: SnapObject[] = [...got.values()]
    .sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type))
    .map((g) => {
      let text = JSON.stringify(g.cap.spec).replace(UUID, (u) => {
        const t = map.get(u.toLowerCase()) ?? map.get(u);
        return t ?? u;
      });
      let name = g.cap.name;
      for (const r of [...(m.replace ?? []), ...(source.replace ?? [])]) {
        text = text.split(jsonText(r.value)).join(jsonText(r.with));
        name = name.split(r.value).join(r.with);
      }
      return { type: g.type, name, spec: JSON.parse(text) as Obj };
    });
  applyParameters(objects, m.parameters ?? []);
  // References to objects outside the package cannot be deployed: assistant queues and program
  // mappings keep only the package's queues.
  for (const o of objects) {
    if (o.type === "assistant") o.spec.queues = (o.spec.queues as Obj[]).filter((q) => String(q.id).startsWith("@{"));
    if (o.type === "staprogram") o.spec.queueIds = (o.spec.queueIds as string[]).filter((q) => q.startsWith("@{"));
  }
  const unresolved = new Set<string>();
  for (const o of objects) for (const u of JSON.stringify(o.spec).match(UUID) ?? []) if (!keep.has(u) && !divisions.has(u)) unresolved.add(u);
  const snap: Snapshot = { at: new Date().toISOString(), region: profile.region, objects, unresolved: [...unresolved] };
  fs.writeFileSync(path.join(src.pkg, "snapshot.json"), `${JSON.stringify(snap, null, 2)}\n`);
  return snap;
}

/**
 * Removes the actions with these Architect tracking ids from a flow's YAML. Works on the text, so
 * everything else stays byte for byte: an action is a list item `- kind:` whose own block holds
 * `trackingId: n`; it ends where the next line is indented no deeper than its dash.
 */
export function removeFlowActions(yaml: string, trackingIds: number[]): { yaml: string; removed: number } {
  const lines = yaml.split("\n");
  const indent = (l: string) => l.length - l.trimStart().length;
  let removed = 0;
  for (const id of trackingIds) {
    const at = lines.findIndex((l) => new RegExp(`^\\s*trackingId: ${id}\\s*$`).test(l));
    if (at < 0) continue;
    let start = at;
    while (start >= 0 && !(/^\s*- [\w]+:\s*$/.test(lines[start]!) && indent(lines[start]!) + 4 === indent(lines[at]!))) start--;
    if (start < 0) continue;
    let end = start + 1;
    while (end < lines.length && (lines[end]!.trim() === "" || indent(lines[end]!) > indent(lines[start]!))) end++;
    lines.splice(start, end - start);
    removed++;
  }
  return { yaml: lines.join("\n"), removed };
}

/** A string as it appears inside JSON text (quotes and backslashes escaped). */
const jsonText = (s: string) => JSON.stringify(s).slice(1, -1);

// ------------------------------------------------------------------- deploy

interface DeployRecord {
  profile: string;
  at: string;
  division?: string;
  /** Token → id in this org, created or reused. */
  ids: Record<string, string>;
  created: Array<{ type: string; name: string; id: string }>;
  reused: Array<{ type: string; name: string; id: string }>;
  /** The WhatsApp number the deploy routed to the demo's message flow, and the flow it had before. */
  routing?: { integrationId: string; integration: string; phone?: string; recipientId: string; previousFlowId?: string; previousFlow?: string };
  /** Customer channel of the last deploy (manifest channels). */
  channel?: string;
  /** Parameter values of the last deploy (the local pages use them too). */
  params?: Record<string, string>;
  presenter?: { id: string; name: string };
  /** Flows a deploy brought to the snapshot's state (see TypeDef.refresh). */
  refreshed?: Record<string, { source: string; result: string }>;
}
const recordFile = (id: string, profile: string) => path.join(recordDir(id), `${profile}.json`);
function loadRecord(id: string, profile: string): DeployRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(recordFile(id, profile), "utf8")) as DeployRecord;
  } catch {
    return undefined;
  }
}
function saveRecord(id: string, r: DeployRecord): void {
  fs.mkdirSync(recordDir(id), { recursive: true });
  fs.writeFileSync(recordFile(id, r.profile), `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
}
function listDeployments(id: string): DemoInfo["deployments"] {
  try {
    return fs
      .readdirSync(recordDir(id))
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(recordDir(id), f), "utf8")) as DeployRecord)
      .map((r) => ({ profile: r.profile, at: r.at, created: r.created.length, reused: r.reused.length, division: r.division, ...(r.channel ? { channel: r.channel } : {}), ...(r.presenter ? { presenter: r.presenter.name } : {}), ...(r.params ? { params: r.params } : {}), ...(r.routing ? { routing: { integration: r.routing.integration, phone: r.routing.phone } } : {}) }));
  } catch {
    return [];
  }
}

function resolve(spec: Obj, ids: Record<string, string>, what: string): Obj {
  const text = JSON.stringify(spec).replace(/@\{[^}]+\}/g, (t) => {
    const v = ids[t];
    if (v === undefined) {
      if (t.startsWith("@{param:")) throw invalid(`${what} needs "${t.slice(8, -1).split(".")[0]}": enter it on the Demos page.`);
      throw new GctkError("DEMO_REF", `${what} needs ${t.slice(2, -1).replace(":", " ")}, which is not in this org.`);
    }
    return jsonText(v);
  });
  return JSON.parse(text) as Obj;
}

/** Checks the presenter's values and turns them into tokens: @{param:x}, for phones also .digits and .masked. */
export function parameterValues(params: DemoParameter[], input: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of params) {
    let v = String(input[p.id] ?? "").trim();
    if (!v) {
      if (!p.optional) throw invalid(`Enter "${p.label}".`);
      continue;
    }
    if (p.format === "phone") {
      v = v.replace(/[\s()/-]/g, "").replace(/^00/, "+");
      if (!/^\+[1-9]\d{6,14}$/.test(v)) throw invalid(`"${p.label}": use the international format, e.g. +4915112345678.`);
      out[`@{param:${p.id}.digits}`] = v.slice(1);
      out[`@{param:${p.id}.masked}`] = `${v.slice(0, -6)}•• ••${v.slice(-2)}`;
    }
    if (p.format === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw invalid(`"${p.label}" is not an email address.`);
    out[`@{param:${p.id}}`] = v;
  }
  return out;
}

export interface DeployOptions {
  profile: string;
  /** Division of the target the objects go into (default: Home). */
  divisionId?: string;
  /** The user who presents: member of the demo's queues. */
  presenterId?: string;
  /** WhatsApp integration to route to the demo's message flow (manifest messageRouting). */
  whatsappIntegrationId?: string;
  /** Values for the manifest's parameters. */
  params?: Record<string, string>;
  /** Customer channel (manifest channels; default: the first). */
  channel?: string;
  client?: GenesysClient;
  log?: (line: string) => void;
}

/** Name used for @{presenter.name} when no presenter is chosen. */
const NO_PRESENTER = "Ihr Kundenservice";

/** Creates the snapshot's objects in the target org, reusing objects that already have the name. */
export async function deployDemo(id: string, o: DeployOptions): Promise<DeployRecord> {
  const src = sourceOf(id);
  const m = loadManifest(src.pkg);
  const snap = readSnapshot(src.pkg);
  if (!snap) throw invalid("Take a snapshot first.");
  const values = parameterValues(m.parameters ?? [], o.params);
  const channel = o.channel || m.channels?.[0]?.id;
  if (m.channels && !m.channels.some((ch) => ch.id === channel)) throw invalid(`Unknown customer channel "${channel}". Known: ${m.channels.map((ch) => ch.id).join(", ")}.`);
  const forChannel = (x?: string) => !x || x === channel;
  const c = o.client ?? new GenesysClient(loadProfile(o.profile), { source: "ui" });
  const log = o.log ?? (() => {});
  const divisions = await all(c, "/api/v2/authorization/divisions");
  const division = (o.divisionId ? divisions.find((d) => d.id === o.divisionId) : divisions.find((d) => d.homeDivision)) ?? divisions[0];
  if (!division) throw invalid("No division is visible to this org's OAuth client.");
  const rec: DeployRecord = loadRecord(id, o.profile) ?? { profile: o.profile, at: "", ids: {}, created: [], reused: [] };
  rec.at = new Date().toISOString();
  rec.division = division.name;
  rec.channel = channel;
  rec.params = Object.fromEntries((m.parameters ?? []).filter((p) => values[`@{param:${p.id}}`]).map((p) => [p.id, values[`@{param:${p.id}}`]!]));
  const presenterName = o.presenterId ? await c.get<Obj>(`/api/v2/users/${o.presenterId}`).then((r) => r.body.name as string | undefined).catch(() => undefined) : undefined;
  rec.presenter = o.presenterId ? { id: o.presenterId, name: presenterName ?? NO_PRESENTER } : undefined;
  const extra = { ...values, "@{presenter.name}": rec.presenter?.name ?? NO_PRESENTER };
  const env: DeployEnv = { client: c, division: { id: division.id, name: division.name }, presenter: o.presenterId, log, refreshed: (rec.refreshed ??= {}) };
  try {
    const changed = (obj: SnapObject): SnapObject => {
      const ch = (m.channelChanges ?? []).filter((x) => x.channel === channel && x.type === obj.type && x.name === obj.name);
      if (!ch.length || typeof obj.spec.yaml !== "string") return obj;
      const r = removeFlowActions(obj.spec.yaml, ch.flatMap((x) => x.removeActions));
      if (r.removed !== ch.reduce((n, x) => n + x.removeActions.length, 0)) log(`! ${obj.name}: only ${r.removed} of the actions to remove for this channel were found`);
      return { ...obj, spec: { ...obj.spec, yaml: r.yaml } };
    };
    for (const obj of [...snap.objects.map(changed), ...(m.create ?? []).filter((x) => forChannel(x.channel))].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type))) {
      const def = TYPES[obj.type]!;
      const key = token(obj.type, obj.name);
      const existing = await def.find(c, obj.name);
      if (existing) {
        rec.ids[key] = existing;
        if (!rec.created.some((x) => x.id === existing) && !rec.reused.some((x) => x.id === existing)) rec.reused.push({ type: obj.type, name: obj.name, id: existing });
        if (def.subsOf) for (const [k, v] of Object.entries(await def.subsOf(c, existing, obj.spec))) rec.ids[token(obj.type, obj.name, k)] = v;
        if (def.refresh && rec.created.some((x) => x.id === existing)) {
          const changed = await def.refresh(existing, resolve(obj.spec, { ...rec.ids, ...extra }, `${def.label} "${obj.name}"`), env);
          log(changed ? `~ ${def.label} "${obj.name}" brought to the demo's version` : `= ${def.label} "${obj.name}" already the demo's version`);
          continue;
        }
        if (def.update && JSON.stringify(obj.spec).includes("@{param:")) {
          await def.update(c, existing, resolve(obj.spec, { ...rec.ids, ...extra }, `${def.label} "${obj.name}"`));
          log(`~ ${def.label} "${obj.name}" already there, updated with your values`);
          continue;
        }
        log(`= ${def.label} "${obj.name}" already there`);
        continue;
      }
      log(`+ ${def.label} "${obj.name}"`);
      let made: { id: string; subs?: Record<string, string> };
      try {
        made = await def.create(resolve(obj.spec, { ...rec.ids, ...extra }, `${def.label} "${obj.name}"`), env);
      } catch (err) {
        // A create that failed halfway (e.g. a case plan without its steps) would count as
        // "already there" next time: take it out again, so the next deploy starts clean.
        const leftover = await def.find(c, obj.name).catch(() => undefined);
        if (leftover) await def.remove(c, leftover).catch(() => log(`! could not remove the half-made ${def.label} "${obj.name}"`));
        throw err;
      }
      rec.ids[key] = made.id;
      rec.created.push({ type: obj.type, name: obj.name, id: made.id });
      for (const [k, v] of Object.entries(made.subs ?? {})) rec.ids[token(obj.type, obj.name, k)] = v;
      saveRecord(id, rec);
    }
    if (o.whatsappIntegrationId && m.messageRouting && forChannel(m.messageRouting.channel)) await routeWhatsApp(c, rec, o.whatsappIntegrationId, m.messageRouting.flow, log);
  } finally {
    saveRecord(id, rec);
  }
  log(`done: ${rec.created.length} created, ${rec.reused.length} already there`);
  return rec;
}

/** Points the WhatsApp number's message routing at the demo's flow; keeps the flow it had before for Remove. */
async function routeWhatsApp(c: GenesysClient, rec: DeployRecord, integrationId: string, flowName: string, log: (l: string) => void): Promise<void> {
  const flowId = rec.ids[token("messageflow", flowName)];
  if (!flowId) throw invalid(`The message flow "${flowName}" is not part of the deploy; add it to the demo's include list.`);
  const wa = (await c.get<Obj>(`/api/v2/conversations/messaging/integrations/whatsapp/${integrationId}`)).body;
  const recipientId = wa.recipient?.id;
  if (!recipientId) throw invalid(`The WhatsApp integration "${wa.name}" has no message routing (recipient) yet; wait until it is active.`);
  const before = (await c.get<Obj>(`/api/v2/routing/message/recipients/${recipientId}`)).body;
  if (before.flow?.id !== flowId) {
    await put(c, `/api/v2/routing/message/recipients/${recipientId}`, { flow: { id: flowId } });
    log(`~ message routing: ${wa.name}${wa.phoneNumber ? ` (${wa.phoneNumber})` : ""} → "${flowName}"${before.flow?.name ? ` (was "${before.flow.name}")` : ""}`);
  } else log(`= message routing: ${wa.name} already goes to "${flowName}"`);
  // Keep the flow from before the first deploy, not the demo's own flow from a second one.
  const keep = rec.routing?.integrationId === integrationId ? rec.routing : undefined;
  if (rec.routing && !keep) await restoreRouting(c, rec, log);
  rec.routing = keep ?? { integrationId, integration: wa.name, phone: wa.phoneNumber, recipientId, ...(before.flow?.id && before.flow.id !== flowId ? { previousFlowId: before.flow.id, previousFlow: before.flow.name } : {}) };
}

async function restoreRouting(c: GenesysClient, rec: DeployRecord, log: (l: string) => void): Promise<void> {
  const r = rec.routing;
  if (!r) return;
  await put(c, `/api/v2/routing/message/recipients/${r.recipientId}`, { flow: r.previousFlowId ? { id: r.previousFlowId } : null });
  log(`~ message routing: ${r.integration} → ${r.previousFlow ? `"${r.previousFlow}" again` : "no flow (as before)"}`);
  rec.routing = undefined;
}

/** Deletes what the deploys created in this org, newest first; objects that were already there stay. */
export async function removeDemo(id: string, o: { profile: string; client?: GenesysClient; log?: (l: string) => void }): Promise<{ removed: number; failed: string[] }> {
  const rec = loadRecord(id, o.profile);
  if (!rec) throw invalid("Nothing was deployed into this org.");
  const c = o.client ?? new GenesysClient(loadProfile(o.profile), { source: "ui" });
  const log = o.log ?? (() => {});
  const failed: string[] = [];
  let removed = 0;
  // A flow a number still routes to cannot be deleted: give the number its old flow back first.
  try {
    await restoreRouting(c, rec, log);
  } catch (err) {
    failed.push(`message routing of ${rec.routing?.integration}: ${(err as Error).message}`);
  }
  for (const x of [...rec.created].reverse()) {
    const def = TYPES[x.type]!;
    try {
      await def.remove(c, x.id);
      removed++;
      log(`- ${def.label} "${x.name}"`);
      rec.created = rec.created.filter((y) => y.id !== x.id);
    } catch (err) {
      const msg = err instanceof GctkError && /HTTP_404|HTTP_410/.test(err.code) ? undefined : (err as Error).message;
      if (msg) {
        failed.push(`${def.label} "${x.name}": ${msg}`);
        log(`! ${def.label} "${x.name}": ${msg}`);
      } else rec.created = rec.created.filter((y) => y.id !== x.id);
    }
  }
  if (!rec.created.length && !rec.routing) fs.rmSync(recordFile(id, o.profile), { force: true });
  else saveRecord(id, rec);
  return { removed, failed };
}

// ------------------------------------------------------------ prerequisites

export interface PrereqResult {
  text: string;
  state: "ok" | "missing" | "manual" | "error";
  detail?: string;
}

/** Checks the manifest's prerequisites against the target org (those with a check), and lists the rest. */
export async function checkPrerequisites(id: string, profile: string, client?: GenesysClient): Promise<PrereqResult[]> {
  const m = loadManifest(sourceOf(id).pkg);
  const c = client ?? new GenesysClient(loadProfile(profile), { source: "ui" });
  const out: PrereqResult[] = [];
  for (const p of m.prerequisites ?? []) {
    if (!p.check) {
      out.push({ text: p.text, state: "manual" });
      continue;
    }
    try {
      const body = (await c.get<Obj>(p.check.get, p.check.query ?? {})).body;
      const n = Array.isArray(body?.entities) ? body.entities.length : undefined;
      if (p.check.expect === "entities" && !n) out.push({ text: p.text, state: "missing", detail: "nothing found in the org" });
      else out.push({ text: p.text, state: "ok", ...(n !== undefined ? { detail: `${n} found` } : {}) });
    } catch (err) {
      const code = err instanceof GctkError ? err.code : "";
      out.push({ text: p.text, state: code === "HTTP_403" || code === "HTTP_404" ? "missing" : "error", detail: code === "HTTP_403" ? "not licensed or no permission" : (err as Error).message });
    }
  }
  return out;
}

// ----------------------------------------------------------------- commands

interface ProcInfo {
  pid: number;
  demo: string;
  command: string;
  profile: string;
  startedAt: string;
  log: string;
}
const procFile = () => path.join(gctkHome(), "demos", "processes.json");
function procs(): Record<string, ProcInfo> {
  try {
    return JSON.parse(fs.readFileSync(procFile(), "utf8")) as Record<string, ProcInfo>;
  } catch {
    return {};
  }
}
function saveProcs(p: Record<string, ProcInfo>): void {
  fs.mkdirSync(path.dirname(procFile()), { recursive: true });
  fs.writeFileSync(procFile(), `${JSON.stringify(p, null, 2)}\n`, { mode: 0o600 });
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export interface CommandStatus {
  id: string;
  label: string;
  url?: string;
  /** Pages of the local part worth opening (label → URL). */
  links?: Array<{ label: string; url: string }>;
  running: boolean;
  profile?: string;
  startedAt?: string;
}

/** The manifest's `local` part shows up as a command with this id; it runs inside gctk. */
const LOCAL = "local";
const locals = new Map<string, { handle: LocalHandle; profile: string; startedAt: string }>();
const logFile = (id: string, cmdId: string) => path.join(gctkHome(), "demos", `${id}-${cmdId}.log`);

export function commandStatus(id: string): CommandStatus[] {
  const m = loadManifest(sourceOf(id).pkg);
  const p = procs();
  const out: CommandStatus[] = [];
  if (m.local) {
    const r = locals.get(id);
    const web = m.local.web;
    out.push({ id: LOCAL, label: m.local.label, url: web ? `http://localhost:${web.port}/${web.open ?? ""}` : undefined, links: (web?.links ?? []).map((l) => ({ label: l.label, url: `http://localhost:${web!.port}/${l.path}` })), running: Boolean(r), ...(r ? { profile: r.profile, startedAt: r.startedAt } : {}) });
  }
  for (const cmd of m.commands ?? []) {
    const r = p[`${id}:${cmd.id}`];
    const running = Boolean(r && alive(r.pid));
    out.push({ id: cmd.id, label: cmd.label, url: cmd.url, running, ...(running ? { profile: r!.profile, startedAt: r!.startedAt } : {}) });
  }
  return out;
}

/** Values the local part and commands may use: deployed ids, parameters, presenter, org. */
function runValues(m: DemoManifest, rec: DeployRecord | undefined, profileRegion: string): Record<string, string> {
  return {
    ...(rec?.ids ?? {}),
    ...parameterValues((m.parameters ?? []).map((p) => ({ ...p, optional: true })), rec?.params ?? {}),
    "@{presenter.name}": rec?.presenter?.name ?? NO_PRESENTER,
    "@{org.region}": profileRegion,
    "@{org.messengerEnv}": environmentFor(profileRegion),
  };
}

async function startLocalPart(id: string, src: Source, m: DemoManifest, profileName: string, client?: GenesysClient): Promise<CommandStatus> {
  await stopLocalPart(id);
  const rec = loadRecord(id, profileName);
  if (!rec) throw invalid(`Deploy the demo into ${profileName} first.`);
  const profile = loadProfile(profileName);
  const file = logFile(id, LOCAL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "", { mode: 0o600 });
  const log = (line: string) => fs.appendFileSync(file, `${new Date().toLocaleTimeString()}  ${line}\n`);
  const handle = await startLocal(m.local!, { client: client ?? new GenesysClient(profile, { source: "ui" }), dir: src.pkg, region: profile.region, values: runValues(m, rec, profile.region), log });
  log(`started for ${profileName}`);
  locals.set(id, { handle, profile: profileName, startedAt: new Date().toISOString() });
  return commandStatus(id).find((s) => s.id === LOCAL)!;
}

async function stopLocalPart(id: string): Promise<boolean> {
  const r = locals.get(id);
  if (!r) return false;
  locals.delete(id);
  await r.handle.stop();
  fs.appendFileSync(logFile(id, LOCAL), `${new Date().toLocaleTimeString()}  stopped\n`);
  return true;
}

/** Stops everything that runs inside gctk (when the UI shuts down). */
export async function stopAllLocal(): Promise<void> {
  await Promise.all([...locals.keys()].map((id) => stopLocalPart(id)));
}

/**
 * Starts a demo command in the background, in its own process group, with the org's credentials
 * and the deployed objects' ids in its environment. Output goes to a log file in the gctk home.
 * The manifest's local part (id "local") starts inside gctk instead.
 */
export async function startCommand(id: string, cmdId: string, profileName: string, client?: GenesysClient): Promise<CommandStatus> {
  const src = sourceOf(id);
  const m = loadManifest(src.pkg);
  if (cmdId === LOCAL && m.local) return startLocalPart(id, src, m, profileName, client);
  const cmd = (m.commands ?? []).find((x) => x.id === cmdId);
  if (!cmd) throw invalid(`Unknown command "${cmdId}".`);
  await stopCommand(id, cmdId);
  const profile = loadProfile(profileName);
  const creds = loadCredentials(profile);
  const rec = loadRecord(id, profileName);
  const ids: Record<string, string> = { ...runValues(m, rec, profile.region), "@{org.clientId}": creds.clientId, "@{org.clientSecret}": creds.clientSecret, "@{org.name}": profile.name };
  const isSource = profileName === snapshotSource(id)?.profile;
  const fill = (v: string) => v.replace(/@\{[^}]+\}/g, (t) => ids[t] ?? (isSource ? "" : t));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^GCTK_(APPROVAL_KEY|UI_TOKEN|CLIENT_SECRET)$/.test(k)) delete env[k];
  for (const [k, v] of Object.entries(cmd.env ?? {})) env[k] = fill(v);
  if (!isSource) for (const [k, v] of Object.entries(cmd.envOtherOrg ?? {})) env[k] = fill(v);
  const missing = Object.entries(env).filter(([, v]) => typeof v === "string" && /@\{[^}]+\}/.test(v)).map(([k]) => k);
  if (missing.length) throw invalid(`Deploy the demo into ${profileName} first: ${missing.join(", ")} need its objects.`);
  const log = logFile(id, cmdId);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, "w", 0o600);
  const child = spawn(cmd.run[0]!, cmd.run.slice(1), { cwd: path.resolve(src.pkg, cmd.cwd), env, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  fs.closeSync(fd);
  if (!child.pid) throw new GctkError("DEMO_COMMAND", `${cmd.label} did not start.`);
  saveProcs({ ...procs(), [`${id}:${cmdId}`]: { pid: child.pid, demo: id, command: cmdId, profile: profileName, startedAt: new Date().toISOString(), log } });
  return commandStatus(id).find((s) => s.id === cmdId)!;
}

export async function stopCommand(id: string, cmdId: string): Promise<boolean> {
  if (cmdId === LOCAL) return stopLocalPart(id);
  const p = procs();
  const r = p[`${id}:${cmdId}`];
  if (!r) return false;
  if (alive(r.pid)) {
    try {
      process.kill(-r.pid, "SIGTERM");
    } catch {
      try {
        process.kill(r.pid, "SIGTERM");
      } catch {
        // gone meanwhile
      }
    }
  }
  delete p[`${id}:${cmdId}`];
  saveProcs(p);
  return true;
}

export function commandLog(id: string, cmdId: string, lines = 200): string {
  try {
    return fs.readFileSync(logFile(id, cmdId), "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/** For the page: the users of the org, to pick the presenter. */
export async function orgUsers(profile: string, client?: GenesysClient): Promise<Array<{ id: string; name: string; email?: string }>> {
  const c = client ?? new GenesysClient(loadProfile(profile), { source: "ui" });
  return (await all(c, "/api/v2/users", { state: "active" })).map((u) => ({ id: u.id, name: u.name, email: u.email })).sort((a, b) => a.name.localeCompare(b.name));
}
/** The org's WhatsApp integrations and where their messages go now. */
export async function orgWhatsApp(profile: string, client?: GenesysClient): Promise<Array<{ id: string; name: string; phone?: string; status?: string; flow?: string }>> {
  const c = client ?? new GenesysClient(loadProfile(profile), { source: "ui" });
  const list = await all(c, "/api/v2/conversations/messaging/integrations/whatsapp");
  return Promise.all(list.map(async (w) => {
    let flow: string | undefined;
    try {
      if (w.recipient?.id) flow = (await c.get<Obj>(`/api/v2/routing/message/recipients/${w.recipient.id}`)).body.flow?.name;
    } catch {
      // routing not readable
    }
    return { id: w.id, name: w.name, phone: w.phoneNumber, status: w.status, ...(flow ? { flow } : {}) };
  }));
}

export async function orgDivisions(profile: string, client?: GenesysClient): Promise<Array<{ id: string; name: string; home: boolean }>> {
  const c = client ?? new GenesysClient(loadProfile(profile), { source: "ui" });
  return (await all(c, "/api/v2/authorization/divisions")).map((d) => ({ id: d.id, name: d.name, home: Boolean(d.homeDivision) }));
}
