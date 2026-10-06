import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GenesysClient } from "./client.js";
import { hasStoredCredentials, loadCredentials } from "./credentials.js";
import { GctkError } from "./errors.js";
import { gctkHome } from "./paths.js";
import { listProfiles, loadProfile, type Profile } from "./profiles.js";

/**
 * AXL (AI Agent eXperience Lab) workshops run in the Cursor app with the axl-lab-facilitator skill
 * and the AVA harness MCP server (ava-mcp). On the UI's AXL page the user keeps a list of workshops,
 * each with its own org and folder; the folder is opened in Cursor and the skill writes its sessions
 * to axl-sessions/ in it.
 *
 * gctk writes an ava-harness server into each workshop folder's own .cursor/mcp.json (never the
 * global ~/.cursor/mcp.json, so other projects are not affected), and rewrites it whenever the user
 * changes the workshop's org or folder. The server runs `gctk axl-harness --workshop <id> --org
 * <profile>`, which reads that profile's credentials from the keychain and starts `ava-mcp serve`:
 * no secret in a Cursor file. The launcher only accepts a workshop that exists in gctk with exactly
 * that org (the file lives in the workspace, where the agent can edit it). The harness writes to the
 * org directly, so only sandbox and dev profiles are allowed (maintainer decision 2026-09-29),
 * checked again at every start.
 */

export const AXL_TIERS = ["sandbox", "dev"] as const;

export interface AxlWorkshop {
  /** Stable id, used in the folder's mcp.json and the harness start record. */
  id: string;
  /** What the user calls it, usually the customer. */
  name: string;
  /** gctk profile the harness works on (sandbox/dev only). */
  profile?: string;
  /** Absolute folder opened in Cursor; sessions go to its axl-sessions/. */
  folder?: string;
  /** What the starting prompt is built from (the user's text; the UI builds the prompt). */
  brief?: AxlBrief;
  created: string;
}

/** Inputs of the research prompt and the test strategy, entered on the AXL page. */
export interface AxlBrief {
  customer?: string;
  useCase?: string;
  moreUseCases?: number;
  knowledge?: string;
  persona?: string;
  language?: "de" | "en";
  functionPath?: boolean;
  runsPerCase?: number;
  threshold?: number;
  /** What happens once the threshold is reached. */
  afterThreshold?: "decide" | "uat" | "continue";
  maxVersions?: number;
  parallel?: number;
}

const clampInt = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined);
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** Keeps only known fields in their ranges; the brief is the user's text and never interpreted here. */
export function cleanBrief(raw: unknown): AxlBrief | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const b: AxlBrief = {
    customer: text(r.customer, 200),
    useCase: text(r.useCase, 4000),
    moreUseCases: clampInt(r.moreUseCases, 0, 5),
    knowledge: text(r.knowledge, 2000),
    persona: text(r.persona, 80),
    language: r.language === "de" || r.language === "en" ? r.language : undefined,
    functionPath: typeof r.functionPath === "boolean" ? r.functionPath : undefined,
    runsPerCase: clampInt(r.runsPerCase, 1, 5),
    threshold: clampInt(r.threshold, 50, 100),
    afterThreshold: r.afterThreshold === "decide" || r.afterThreshold === "uat" || r.afterThreshold === "continue" ? r.afterThreshold : undefined,
    maxVersions: clampInt(r.maxVersions, 1, 10),
    parallel: clampInt(r.parallel, 1, 4),
  };
  for (const k of Object.keys(b) as Array<keyof AxlBrief>) if (b[k] === undefined) delete b[k];
  return Object.keys(b).length ? b : undefined;
}

export interface AxlSettings {
  workshops: AxlWorkshop[];
  /** Absolute path of the harness executable (ava-mcp); never looked up on PATH. */
  harnessCommand?: string;
}

const settingsFile = () => path.join(gctkHome(), "axl.json");
const defaultHarness = () => path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "ava-mcp.exe" : "ava-mcp");
/** The server name the AXL and ava-* skills expect (they call the ava-harness* tools). */
export const HARNESS_SERVER = "ava-harness";
/** Where the axl-lab-facilitator skill keeps its session folders, relative to the Cursor project. */
export const SESSIONS_SUBDIR = "axl-sessions";
export const workshopMcpFile = (dir: string) => path.join(dir, ".cursor", "mcp.json");
export const globalCursorMcpFile = () => path.join(os.homedir(), ".cursor", "mcp.json");
export const sessionsDirOf = (w: Pick<AxlWorkshop, "folder">) => (w.folder ? path.join(w.folder, SESSIONS_SUBDIR) : undefined);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

/**
 * Genesys Cloud domain -> harness habitat. Copied from ava-mcp 1.5.4 config.py (PUBLIC_BASE_URLS),
 * checked 2026-09-29. A region missing here cannot be used for AXL until the harness knows it.
 */
export const HABITATS: Record<string, string> = {
  "mypurecloud.com": "prod",
  "mypurecloud.jp": "prod-apne1",
  "apne2.pure.cloud": "prod-apne2",
  "apne3.pure.cloud": "prod-apne3",
  "aps1.pure.cloud": "prod-aps1",
  "apse1.pure.cloud": "prod-apse1",
  "mypurecloud.com.au": "prod-apse2",
  "cac1.pure.cloud": "prod-cac1",
  "mypurecloud.de": "prod-euc1",
  "euc2.pure.cloud": "prod-euc2",
  "mypurecloud.ie": "prod-euw1",
  "euw2.pure.cloud": "prod-euw2",
  "mec1.pure.cloud": "prod-mec1",
  "mxc1.pure.cloud": "prod-mxc1",
  "sae1.pure.cloud": "prod-sae1",
  "usw2.pure.cloud": "prod-usw2",
};

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "workshop";
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export function loadAxlSettings(): AxlSettings {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as Record<string, unknown>;
  } catch {
    return { workshops: [] };
  }
  const workshops: AxlWorkshop[] = [];
  if (Array.isArray(raw.workshops)) {
    for (const w of raw.workshops as Array<Record<string, unknown>>) {
      const id = str(w.id);
      if (!id || !ID_RE.test(id)) continue;
      const brief = cleanBrief(w.brief);
      workshops.push({ id, name: str(w.name) ?? id, profile: str(w.profile), folder: str(w.folder), ...(brief ? { brief } : {}), created: str(w.created) ?? new Date(0).toISOString() });
    }
  } else if (str(raw.profile) || str(raw.workshopDir)) {
    // 0.20.x kept a single workshop: it becomes the first one of the list.
    const folder = str(raw.workshopDir);
    const name = folder ? path.basename(folder) : "Workshop";
    workshops.push({ id: slug(name), name, profile: str(raw.profile), folder, created: new Date(0).toISOString() });
  }
  return { workshops, harnessCommand: str(raw.harnessCommand) };
}

function writeSettings(s: AxlSettings): void {
  fs.mkdirSync(gctkHome(), { recursive: true });
  fs.writeFileSync(settingsFile(), `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
}

function assertAxlProfile(p: Profile): void {
  if (!(AXL_TIERS as readonly string[]).includes(p.tier)) {
    throw new GctkError("AXL_TIER", `"${p.name}" is a ${p.tier} org. AXL workshops only run on sandbox or dev orgs: the harness writes straight to the org.`);
  }
  if (!HABITATS[p.region]) throw new GctkError("AXL_REGION", `The AVA harness does not know the region ${p.region} of "${p.name}".`);
}

const absolute = (v: string, what: string) => {
  const p = v.trim().replace(/^~(?=$|[\\/])/, os.homedir());
  if (p && !path.isAbsolute(p)) throw new GctkError("INVALID_INPUT", `${what} must be an absolute path.`);
  return p ? path.resolve(p) : undefined;
};

export function getWorkshop(id: string, s = loadAxlSettings()): AxlWorkshop {
  const w = s.workshops.find((x) => x.id === id);
  if (!w) throw new GctkError("NOT_FOUND", `No AXL workshop "${id}" in gctk. It may have been removed on the AXL page.`);
  return w;
}

/** Creates (no id) or changes a workshop; fields left out stay as they are. */
export function saveWorkshop(input: { id?: string; name?: string; profile?: string; folder?: string; brief?: unknown }): AxlWorkshop {
  const s = loadAxlSettings();
  let w: AxlWorkshop;
  if (input.id) {
    w = { ...getWorkshop(input.id, s) };
  } else {
    const name = (input.name ?? "").trim() || (input.folder ? path.basename(input.folder.trim()) : "");
    if (!name) throw new GctkError("INVALID_INPUT", "Give the workshop a name (e.g. the customer).");
    let id = slug(name);
    for (let n = 2; s.workshops.some((x) => x.id === id); n++) id = `${slug(name).slice(0, 55)}-${n}`;
    w = { id, name, created: new Date().toISOString() };
  }
  if (input.name !== undefined && input.name.trim()) w.name = input.name.trim().slice(0, 120);
  if (input.profile !== undefined) {
    if (input.profile) assertAxlProfile(loadProfile(input.profile));
    w.profile = input.profile || undefined;
  }
  if (input.folder !== undefined) {
    w.folder = absolute(input.folder, "The workshop folder");
    const other = w.folder && s.workshops.find((x) => x.id !== w.id && x.folder && path.resolve(x.folder) === w.folder);
    if (other) throw new GctkError("INVALID_INPUT", `The workshop "${other.name}" already uses this folder. Each workshop needs its own folder.`);
  }
  if (input.brief !== undefined) {
    const brief = cleanBrief(input.brief);
    if (brief) w.brief = brief;
    else delete w.brief;
  }
  s.workshops = [...s.workshops.filter((x) => x.id !== w.id), w].sort((a, b) => a.created.localeCompare(b.created));
  writeSettings(s);
  return w;
}

/** Removes a workshop from gctk and its harness server from the folder's mcp.json; the folder and sessions stay. */
export function removeWorkshop(id: string): { removedServer: boolean } {
  const s = loadAxlSettings();
  const w = getWorkshop(id, s);
  let removedServer = false;
  if (w.folder) {
    const file = workshopMcpFile(w.folder);
    try {
      const mcp = readMcp(file);
      const e = mcp.mcpServers?.[HARNESS_SERVER];
      if (isOurs(e) && workshopArg(e) === id) {
        delete mcp.mcpServers![HARNESS_SERVER];
        fs.writeFileSync(file, `${JSON.stringify(mcp, null, 2)}\n`);
        removedServer = true;
      }
    } catch {
      // unreadable file: leave it alone
    }
  }
  s.workshops = s.workshops.filter((x) => x.id !== id);
  writeSettings(s);
  return { removedServer };
}

export function saveHarnessCommand(value: string): AxlSettings {
  const s = loadAxlSettings();
  s.harnessCommand = absolute(value, "The harness command");
  writeSettings(s);
  return s;
}

export const harnessCommandOf = (s: AxlSettings) => s.harnessCommand || defaultHarness();

// ------------------------------------------------------------ sessions

export const AXL_ARTIFACTS = [
  { id: "pov", label: "POV deck", files: ["pov-deck.html", "pov-deck.pdf"] },
  { id: "spec", label: "Spec artifact", files: ["spec-artifact.md"] },
  { id: "run", label: "Run artifact", files: ["run-artifact.html", "run-artifact.pdf"] },
  { id: "readout", label: "Readout artifact", files: ["readout-artifact.html", "readout-artifact.pdf"] },
] as const;

export interface AxlSession {
  name: string;
  /** Artifact ids present: pov, spec, run, readout. */
  artifacts: string[];
  /** The furthest job reached. */
  stage: "new" | "research" | "discovery" | "build" | "readout";
  modified: string;
}

/** Session folders (AXL-<customer>), newest first. Reads names and file presence only. */
export function listAxlSessions(dir: string | undefined): AxlSession[] {
  if (!dir) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && /^AXL-/i.test(e.name))
    .map((e) => {
      const folder = path.join(dir, e.name);
      const files = new Set(fs.readdirSync(folder));
      const artifacts = AXL_ARTIFACTS.filter((a) => a.files.some((f) => files.has(f))).map((a) => a.id);
      const stage = artifacts.includes("readout") ? "readout" : artifacts.includes("run") ? "build" : artifacts.includes("spec") ? "discovery" : artifacts.includes("pov") ? "research" : "new";
      return { name: e.name, artifacts, stage, modified: fs.statSync(folder).mtime.toISOString() } satisfies AxlSession;
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

// ------------------------------------------------------- workshop folder

type McpEntry = { command?: string; args?: string[]; env?: Record<string, string>; [k: string]: unknown };
type McpFile = { mcpServers?: Record<string, McpEntry>; [k: string]: unknown };
function readMcp(file: string): McpFile {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as McpFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new GctkError("INVALID_INPUT", `${file} is not valid JSON; fix it first.`);
  }
}

export interface WorkshopFolderStatus {
  exists: boolean;
  /** The folder's .cursor/mcp.json has an ava-harness server started by gctk. */
  connected: boolean;
  /** The org that server starts with (from the file). */
  org?: string;
  /** Connected, but out of date: other org or workshop, older format, or the gctk it starts is gone. */
  stale: boolean;
}

const isOurs = (e: McpEntry | undefined) => Boolean(e && e.args?.[1] === "axl-harness" && /gctk\.js$/.test(e.args?.[0] ?? ""));
const argOf = (e: McpEntry | undefined, flag: string) => {
  const i = e?.args?.indexOf(flag) ?? -1;
  return i >= 0 ? e!.args![i + 1] : undefined;
};
const workshopArg = (e: McpEntry | undefined) => argOf(e, "--workshop");

export function workshopFolderStatus(w: Pick<AxlWorkshop, "id" | "profile" | "folder">): WorkshopFolderStatus {
  if (!w.folder || !fs.existsSync(w.folder)) return { exists: false, connected: false, stale: false };
  let e: McpEntry | undefined;
  try {
    e = readMcp(workshopMcpFile(w.folder)).mcpServers?.[HARNESS_SERVER];
  } catch {
    e = undefined;
  }
  const connected = isOurs(e);
  const org = connected ? argOf(e, "--org") : undefined;
  const missing = connected && !(fs.existsSync(e!.command ?? "") && fs.existsSync(e!.args![0]!));
  return { exists: true, connected, org, stale: connected && (missing || org !== w.profile || workshopArg(e) !== w.id) };
}

/**
 * Makes the workshop's folder a Cursor project whose ava-harness server is started by gctk with the
 * workshop's org. Only the folder's own .cursor/mcp.json changes; the user's other servers there
 * stay. Settings like the log level are kept from an existing entry; org variables and secrets are
 * never written. Returns true when the file changed.
 */
export function setupWorkshopFolder(id: string, gctkJs: string, node = process.execPath): boolean {
  const { folder: dir, profile } = getWorkshop(id);
  if (!dir) throw new GctkError("INVALID_INPUT", "Set the workshop folder first.");
  if (!profile) throw new GctkError("INVALID_INPUT", "Choose the org for the workshop first.");
  assertAxlProfile(loadProfile(profile));
  fs.mkdirSync(path.join(dir, SESSIONS_SUBDIR), { recursive: true });
  const file = workshopMcpFile(dir);
  const mcp = readMcp(file);
  const old = mcp.mcpServers?.[HARNESS_SERVER];
  const env: Record<string, string> = { FASTMCP_LOG_LEVEL: "ERROR", ...(old?.env ?? {}) };
  for (const k of Object.keys(env)) if (/^(GENESYS_CLIENT_(ID|SECRET)|AVA_HABITAT)$/.test(k)) delete env[k];
  const entry: McpEntry = { ...(old ?? {}), command: node, args: [gctkJs, "axl-harness", "--workshop", id, "--org", profile], env, timeout: old?.timeout ?? 60000 };
  if (JSON.stringify(old) === JSON.stringify(entry)) return false;
  mcp.mcpServers = { ...(mcp.mcpServers ?? {}), [HARNESS_SERVER]: entry };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(mcp, null, 2)}\n`);
  return true;
}

// -------------------------------------------------------------- status

/** The last time Cursor started a workshop's harness through gctk (harness-starts.json). */
export interface HarnessStart {
  at: string;
  profile: string;
  detail: string;
  /** After the folder's .cursor/mcp.json was last written: the current setup is running. */
  sinceSetup: boolean;
}

export interface WorkshopOrg {
  profile: string;
  tier: string;
  region: string;
  habitat?: string;
  credentialsStored: boolean;
  problem?: string;
}

export interface WorkshopStatus {
  workshop: AxlWorkshop;
  org?: WorkshopOrg;
  folder: WorkshopFolderStatus;
  lastStart?: HarnessStart;
  sessionsDir?: string;
  sessions: AxlSession[];
}

export interface AxlStatus {
  workshops: WorkshopStatus[];
  /** ~/.cursor/mcp.json has its own ava-harness (Cursor keeps it next to the folder's). Values are never read out. */
  globalHarness: { present: boolean; inlineSecret: boolean };
  harnessCommand: string;
  harnessInstalled: boolean;
  /** Profiles that may be chosen (sandbox/dev with a region the harness knows). */
  choices: Array<{ name: string; tier: string; region: string }>;
}

function orgOf(profile: string | undefined): WorkshopOrg | undefined {
  if (!profile) return undefined;
  try {
    const p = loadProfile(profile);
    let problem: string | undefined;
    try {
      assertAxlProfile(p);
    } catch (err) {
      problem = (err as Error).message;
    }
    return { profile: p.name, tier: p.tier, region: p.region, habitat: HABITATS[p.region], credentialsStored: hasStoredCredentials(p), problem };
  } catch (err) {
    return { profile, tier: "?", region: "?", credentialsStored: false, problem: (err as Error).message };
  }
}

type StartRecord = { at: string; profile: string; detail: string };
const startsFile = () => path.join(gctkHome(), "harness-starts.json");
function readStarts(): Record<string, StartRecord> {
  try {
    return JSON.parse(fs.readFileSync(startsFile(), "utf8")) as Record<string, StartRecord>;
  } catch {
    return {};
  }
}
export function recordHarnessStart(workshop: string, profile: string, detail: string, at = new Date()): void {
  fs.mkdirSync(gctkHome(), { recursive: true });
  fs.writeFileSync(startsFile(), `${JSON.stringify({ ...readStarts(), [workshop]: { at: at.toISOString(), profile, detail } }, null, 2)}\n`, { mode: 0o600 });
}

export function workshopStatus(w: AxlWorkshop, starts = readStarts()): WorkshopStatus {
  const sessionsDir = sessionsDirOf(w);
  return { workshop: w, org: orgOf(w.profile), folder: workshopFolderStatus(w), lastStart: lastHarnessStart(w, starts), sessionsDir, sessions: listAxlSessions(sessionsDir) };
}

export function axlStatus(globalMcp = globalCursorMcpFile()): AxlStatus {
  const settings = loadAxlSettings();
  const choices: AxlStatus["choices"] = [];
  for (const n of listProfiles()) {
    try {
      const p = loadProfile(n);
      if ((AXL_TIERS as readonly string[]).includes(p.tier) && HABITATS[p.region]) choices.push({ name: p.name, tier: p.tier, region: p.region });
    } catch {
      // unreadable profile: not offered
    }
  }
  let globalEntry: McpEntry | undefined;
  try {
    globalEntry = readMcp(globalMcp).mcpServers?.[HARNESS_SERVER];
  } catch {
    globalEntry = undefined;
  }
  const cmd = harnessCommandOf(settings);
  const starts = readStarts();
  return {
    workshops: settings.workshops.map((w) => workshopStatus(w, starts)),
    globalHarness: { present: Boolean(globalEntry), inlineSecret: Boolean(globalEntry?.env?.GENESYS_CLIENT_SECRET) },
    harnessCommand: cmd,
    harnessInstalled: fs.existsSync(cmd),
    choices,
  };
}

export function lastHarnessStart(w: AxlWorkshop, starts = readStarts()): HarnessStart | undefined {
  const e = starts[w.id];
  if (!e) return undefined;
  let setupAt = 0;
  try {
    if (w.folder) setupAt = fs.statSync(workshopMcpFile(w.folder)).mtimeMs;
  } catch {
    setupAt = 0;
  }
  return { at: e.at, profile: e.profile, detail: e.detail, sinceSetup: Date.parse(e.at) >= setupAt };
}

/** The workshop whose folder is `dir` or contains it (the lab passes its Cursor workspace). */
export function workshopForFolder(st: AxlStatus, dir: string): WorkshopStatus | undefined {
  const d = path.resolve(dir);
  return st.workshops.find((x) => x.workshop.folder && (d === x.workshop.folder || d.startsWith(`${x.workshop.folder}${path.sep}`)));
}

function describeWorkshop(x: WorkshopStatus, st: AxlStatus): string[] {
  const w = x.workshop;
  const lines = [`Workshop "${w.name}" (id ${w.id}).`];
  lines.push(
    x.org
      ? `Org for the AVA harness: ${x.org.profile} (${x.org.tier}, ${x.org.region}, habitat ${x.org.habitat ?? "?"}).${x.org.credentialsStored ? "" : " No credentials stored for it in gctk."}${x.org.problem ? ` Problem: ${x.org.problem}` : ""}`
      : "Org for the AVA harness: not chosen. Ask the user to choose it on the AXL page.",
  );
  if (!w.folder) {
    lines.push("Workshop folder: not set. The user sets it on the AXL page and opens it in Cursor.");
  } else {
    lines.push(`Workshop folder: ${w.folder} (sessions in ${x.sessionsDir}).`);
    lines.push(
      x.folder.connected
        ? `Its .cursor/mcp.json starts the ava-harness server through gctk with ${x.folder.org ?? "?"}${x.folder.stale ? ", but that entry is out of date: the user presses \"Set up folder\" for this workshop on the AXL page" : ""}. The harness uses this org only when Cursor has this folder open and the user switched this project's ava-harness on in Cursor (Settings → MCP)${st.globalHarness.present ? " and the global ava-harness off, which points to its own org" : ""}. ${x.lastStart?.sinceSetup ? `Cursor last started it at ${x.lastStart.at} (${x.lastStart.detail}).` : "Cursor has not started it since it was set up."}`
        : "Its ava-harness server is not set up by gctk yet (button \"Set up folder\" on the AXL page), so the harness uses whatever org Cursor's own settings give it.",
    );
  }
  if (x.sessions.length) {
    lines.push("Sessions (newest first; only read the one the facilitator picks):");
    for (const s of x.sessions.slice(0, 30)) lines.push(`- ${s.name}  ${s.stage}${s.artifacts.length ? ` (${s.artifacts.join(", ")})` : ""}  ${s.modified.slice(0, 10)}`);
  } else if (x.sessionsDir) {
    lines.push("No sessions yet.");
  }
  return lines;
}

/** What gc_axl tells the agent: for its workspace folder the workshop's org and sessions, else the list. */
export function formatAxlStatus(st: AxlStatus, folder?: string): string {
  const head = "AXL workshops (the user manages them on the AXL page of the gctk UI: gc_ui page=axl).";
  if (!st.workshops.length) return `${head}\nNo workshops yet. Ask the user to add one on the AXL page (org and folder), then open that folder in Cursor.`;
  if (folder) {
    const x = workshopForFolder(st, folder);
    if (x) return [head, ...describeWorkshop(x, st)].join("\n");
    return [head, `No workshop uses ${folder}. The ava-harness here is not set up by gctk; ask the user to add a workshop for this folder on the AXL page, or open a workshop folder:`, ...st.workshops.map((x) => `- ${x.workshop.name}: ${x.workshop.folder ?? "no folder"} (${x.workshop.profile ?? "no org"})`)].join("\n");
  }
  return [head, "Pass folder (your Cursor workspace) for the workshop you are in.", ...st.workshops.map((x) => `- ${x.workshop.name} (id ${x.workshop.id}): ${x.workshop.profile ?? "no org"}, ${x.workshop.folder ?? "no folder"}, ${x.sessions.length} session(s)`)].join("\n");
}

// ------------------------------------------------------------ launcher

/**
 * Environment for ava-mcp: the workshop's org, and none of gctk's own secrets. The folder's mcp.json
 * names the workshop and org; only a workshop gctk knows, with exactly that org, is accepted. Entries
 * written by 0.20.x name only the org: accepted when exactly one workshop uses it.
 */
export function harnessEnv(base: NodeJS.ProcessEnv = process.env, ref: { workshop?: string; org?: string } = {}): { env: NodeJS.ProcessEnv; command: string; profile: Profile; workshop: AxlWorkshop } {
  const settings = loadAxlSettings();
  let w: AxlWorkshop | undefined;
  if (ref.workshop) {
    w = getWorkshop(ref.workshop, settings);
  } else {
    const matches = settings.workshops.filter((x) => x.profile && (!ref.org || x.profile === ref.org));
    if (matches.length !== 1) throw new GctkError("AXL_NO_WORKSHOP", "This folder does not name its AXL workshop. Press \"Set up folder\" for it on the AXL page of the gctk UI.");
    w = matches[0]!;
  }
  if (!w.profile) throw new GctkError("AXL_NO_ORG", `The workshop "${w.name}" has no org. Choose one on the AXL page of the gctk UI.`);
  if (ref.org !== undefined && ref.org !== w.profile) {
    throw new GctkError("AXL_ORG_MISMATCH", `This folder starts the harness for "${ref.org}", but the workshop "${w.name}" has "${w.profile}" on the AXL page. Press "Set up folder" there.`);
  }
  const profile = loadProfile(w.profile);
  assertAxlProfile(profile);
  const command = harnessCommandOf(settings);
  if (!path.isAbsolute(command) || !fs.existsSync(command)) throw new GctkError("AXL_NO_HARNESS", `The AVA harness was not found at ${command}. Set its path on the AXL page.`);
  const creds = loadCredentials(profile);
  const env: NodeJS.ProcessEnv = { ...base, GENESYS_CLIENT_ID: creds.clientId, GENESYS_CLIENT_SECRET: creds.clientSecret, AVA_HABITAT: HABITATS[profile.region] };
  for (const k of Object.keys(env)) if (/^GCTK_(APPROVAL_KEY|UI_TOKEN|CLIENT_SECRET)$/.test(k)) delete env[k];
  return { env, command, profile, workshop: w };
}

/**
 * Which AI agent API the org's OAuth client may use. The harness talks to either the public route
 * (/api/v2/agentic/virtualagents, default) or the internal one (/api/v2/apps/agentic/virtualagents,
 * AVA_USE_INTERNAL_SAGE=true); the scopes depend on the client (ava-mcp 1.5.4,
 * endpoints/use-internal-sage.md). One read, a second only if the
 * first is refused. Undefined when neither answers: the harness keeps its default.
 */
export async function sageRoute(client: GenesysClient): Promise<"public" | "internal" | undefined> {
  const refused = (err: unknown) => /^HTTP_40[13]$/.test((err as { code?: string }).code ?? "");
  try {
    await client.get("/api/v2/agentic/virtualagents", { pageSize: 1 });
    return "public";
  } catch (err) {
    if (!refused(err)) return undefined;
  }
  try {
    await client.get("/api/v2/apps/agentic/virtualagents", { pageSize: 1 });
    return "internal";
  } catch {
    return undefined;
  }
}

/** `gctk axl-harness`: runs `ava-mcp serve` on stdio for Cursor. Nothing but the harness writes to stdout. */
export async function runHarness(ref: { workshop?: string; org?: string } = {}, client?: GenesysClient): Promise<number> {
  const { env, command, profile, workshop } = harnessEnv(process.env, ref);
  // An explicit AVA_USE_INTERNAL_SAGE in the folder's mcp.json wins over the check.
  let route = env.AVA_USE_INTERNAL_SAGE ? (/^true$/i.test(env.AVA_USE_INTERNAL_SAGE) ? "internal (set in mcp.json)" : "public (set in mcp.json)") : undefined;
  if (!route) {
    const found = await sageRoute(client ?? new GenesysClient(profile, { source: "cli" }));
    if (found === "internal") env.AVA_USE_INTERNAL_SAGE = "true";
    route = found ? `${found} AI agent API` : "AI agent API not checked";
  }
  recordHarnessStart(workshop.id, profile.name, `${HABITATS[profile.region]}, ${route}`);
  const child = spawn(command, ["serve"], { stdio: "inherit", env });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
