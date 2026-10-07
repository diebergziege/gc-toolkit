import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sign, verify } from "./approval.js";
import { loadAxlSettings, HABITATS } from "./axl.js";
import { type ClientCredentials, deleteCredentials, loadCredentials, readSecret, removeSecret, storeCredentials, writeSecret } from "./credentials.js";
import { GctkError } from "./errors.js";
import { gctkHome } from "./paths.js";
import { assertProfileName, listProfiles, loadProfile, type Profile, removeProfile, saveProfile, TIERS, type Tier } from "./profiles.js";
import { stableGctkJs } from "./stable-gctk.js";
import { resolveRegion } from "./regions.js";

/**
 * Cursor setup (UI page "Cursor setup", MCP tool gc_ai_setup): the MCP servers Cursor loads, read
 * from its config files, with the Genesys Cloud org each server works on. Cursor only, no skills
 * (decision 2026-10-06).
 *
 * Secrets never leave this module unmasked: the page and the tool get `••••` plus the last four
 * characters. Fixes change the user's config files and run only from the UI (a click):
 * - keychain: a plain-text secret moves into the OS keychain; the config entry then starts the server
 *   through `gctk mcp-launch <id>`. The launch record (command, arguments, environment, secret names)
 *   is signed with the approval key, so an edited config or record cannot reuse the secret for
 *   another command. The child gets the record's environment, not the config's.
 * - restore: the reverse, the secret goes back into the file.
 * - remove / clean-env: deletes a server entry, or a variable gctk no longer reads.
 */

export type Editor = "cursor" | "claude-code" | "claude-desktop" | "vscode" | "windsurf" | "other";
export type Scope = "user" | "project" | "plugin";
export const EDITOR_NAMES: Record<Editor, string> = {
  cursor: "Cursor",
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  vscode: "VS Code",
  windsurf: "Windsurf",
  other: "Other",
};

export interface ConfigFile {
  path: string;
  editor: Editor;
  scope: Scope;
  /** Project folder (project scope) or plugin name (plugin scope). */
  project?: string;
  plugin?: string;
  /** Added by the user on the page. */
  added?: boolean;
  exists: boolean;
  /** gctk may rewrite it (plain JSON outside plugin folders). */
  editable: boolean;
  error?: string;
}

export type ProblemKind = "plain-secret" | "header-secret" | "same-secret" | "launch-invalid" | "missing-command" | "obsolete-env" | "unknown-client" | "not-linked" | "unstable-path" | "old-package";

export interface Problem {
  kind: ProblemKind;
  level: "warn" | "info";
  text: string;
  fix?: "keychain" | "restore" | "remove" | "clean-env" | "repair" | "link";
}

export interface ShownVar {
  name: string;
  value: string;
  secret: boolean;
  /** A secret written into the file itself (not a ${…} reference). */
  plain: boolean;
}

export interface ServerAddress {
  file: string;
  /** "mcpServers", "servers", or "projects:<folder>" in ~/.claude.json. */
  section: string;
  name: string;
}

export interface ServerInfo extends ServerAddress {
  key: string;
  editor: Editor;
  scope: Scope;
  project?: string;
  plugin?: string;
  editable: boolean;
  transport: "stdio" | "http";
  command?: string;
  args: string[];
  url?: string;
  env: ShownVar[];
  headers: ShownVar[];
  disabled: boolean;
  genesys: boolean;
  /** How the server gets its Genesys credentials. */
  credentials: "none" | "plain" | "reference" | "keychain" | "org" | "gctk-profile" | "axl" | "project";
  org?: { profile?: string; clientId?: string; region?: string };
  /** Started through gctk mcp-launch. */
  launch?: { id: string; account: string; valid: boolean; secretNames: string[] };
  /** The variables that carry the Genesys credentials, when gctk can change them here (setCredentials). */
  credentialKeys?: CredentialKeys;
  /** Can be linked to an org on the Orgs page (linkToOrg): the org with its OAuth client, and the region the entry names. */
  linkOrg?: { match?: string; region?: string };
  problems: Problem[];
}

export interface RemovedSkill {
  id: string;
  name: string;
  editor: "cursor" | "claude-code";
  /** Where it was; Restore puts it back there. */
  from: string;
  link?: string;
  removedAt: string;
}

export interface CredentialKeys {
  clientId?: string;
  secret?: string;
  /** A region domain (mypurecloud.de) */
  region?: string;
  /** The AVA harness' habitat (prod-euc1), derived from the region. */
  habitat?: string;
}

export interface ManagedSecret {
  account: string;
  names: string[];
  clientId?: string;
  profile?: string;
  usedBy: Array<{ id: string; server: string; file: string }>;
  stored: boolean;
}

/** What Cursor loads (decision 2026-10-06: gctk covers Cursor only; skills are not listed). */
export interface AiSetup {
  files: ConfigFile[];
  servers: ServerInfo[];
  secrets: ManagedSecret[];
  locations: string[];
  /** Skills an earlier gctk moved aside, so they can still be put back. */
  removedSkills: RemovedSkill[];
}

export interface SecretStore {
  get(account: string): string | undefined;
  set(account: string, value: string): void;
  remove(account: string): void;
}
export const keychainStore: SecretStore = { get: readSecret, set: writeSecret, remove: removeSecret };

/** Where the orgs' credentials live (the OS keychain; tests pass their own). */
export interface OrgStore {
  load(p: Profile): ClientCredentials;
  save(p: Profile, c: ClientCredentials): void;
  remove(name: string): void;
}
export const keychainOrgs: OrgStore = { load: loadCredentials, save: storeCredentials, remove: deleteCredentials };

export interface ScanOptions {
  home?: string;
  platform?: NodeJS.Platform;
  /** Windows %APPDATA%. */
  appData?: string;
  store?: SecretStore;
  /** Client id → gctk profile (default: from the keychain, one read per profile). */
  clients?: () => Map<string, string>;
  orgs?: OrgStore;
}

// ------------------------------------------------------------------ helpers

const SECRET_NAME = /(secret|token|password|passwd|api_?key|access_?key|private_?key|credentials?|bearer|authorization)/i;
const NOT_SECRET = /(_id|_url|_uri|_path|_file|_dir|_region|_host|_name|_type)$/i;
const isSecretName = (n: string) => SECRET_NAME.test(n) && !NOT_SECRET.test(n);
const isReference = (v: string) => /^\$\{[^}]+\}$|^\$[A-Z_][A-Z0-9_]*$|^\{\{[^}]+\}\}$/i.test(v.trim());
const GENESYS = /genesys|purecloud|pure\.cloud|ava[-_]?(mcp|harness)|gctk|cicero/i;
const GENESYS_ENV = /^(genesys|genesyscloud|purecloud|gc|gctk|ava)_/i;
/** Variables gctk once wrote and no longer reads. */
const OBSOLETE_ENV = ["GCTK_WORKSPACE"];
const CLIENT_ID = /client_?id$/i;
const REGION = /region$/i;
const ARG_SECRET = /^(--?[\w-]*(secret|token|password|api-?key)[\w-]*=)(.+)$/i;

export const mask = (v: string) => (v.length <= 8 ? "••••" : `••••${v.slice(-4)}`);
const showClientId = (v: string) => (v.length > 10 ? `${v.slice(0, 8)}…` : v);
/** JSON with sorted keys, so equal objects sign and compare equal. */
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sort(value));
}
const sha = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const keyOf = (a: ServerAddress) => sha(`${a.file}\n${a.section}\n${a.name}`).slice(0, 16);
const expand = (p: string, home: string) => (p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p);

function settingsFile() {
  return path.join(gctkHome(), "ai-setup.json");
}
function launchFile() {
  return path.join(gctkHome(), "mcp-launch.json");
}

/** JSON, or JSON with comments and trailing commas (VS Code): the latter is read, never rewritten. */
export function parseJsonc(text: string): { value: unknown; comments: boolean } {
  try {
    return { value: JSON.parse(text), comments: false };
  } catch {
    let out = "";
    let inStr = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (inStr) {
        out += c;
        if (c === "\\") out += text[++i] ?? "";
        else if (c === '"') inStr = false;
      } else if (c === '"') {
        inStr = true;
        out += c;
      } else if (c === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
        out += "\n";
      } else if (c === "/" && text[i + 1] === "*") {
        i += 2;
        while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
        i++;
      } else out += c;
    }
    return { value: JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")), comments: true };
  }
}

function readJson(file: string): { value?: Record<string, unknown>; comments: boolean; error?: string; indent: string | number } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { comments: false, indent: 2, error: (err as NodeJS.ErrnoException).code === "ENOENT" ? undefined : String((err as Error).message) };
  }
  if (!text.trim()) return { value: {}, comments: false, indent: 2 };
  try {
    const { value, comments } = parseJsonc(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { comments, indent: 2, error: "not a JSON object" };
    const indent = /^\{\s*\n(\t)/.test(text) ? "\t" : (/^\{\s*\n( +)/.exec(text)?.[1]?.length ?? 2);
    return { value: value as Record<string, unknown>, comments, indent };
  } catch {
    return { comments: false, indent: 2, error: "not valid JSON" };
  }
}

/** Writes next to the file and renames, so an editor never reads half a file. Keeps the file mode. */
function writeJson(file: string, value: unknown, indent: string | number): void {
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    // new file
  }
  const tmp = `${file}.gctk-${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, indent)}\n`, { mode });
  fs.renameSync(tmp, file);
}

function appSupport(home: string, platform: NodeJS.Platform, appData?: string): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support");
  if (platform === "win32") return appData ?? path.join(home, "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME || path.join(home, ".config");
}

function newestDir(dir: string): string | undefined {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  } catch {
    return undefined;
  }
}
const subdirs = (dir: string) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name);
  } catch {
    return [];
  }
};
const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- locations

export function loadLocations(): string[] {
  try {
    const v = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as { locations?: unknown };
    return Array.isArray(v.locations) ? v.locations.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function saveLocations(list: string[]): void {
  fs.mkdirSync(gctkHome(), { recursive: true });
  fs.writeFileSync(settingsFile(), `${JSON.stringify({ locations: list }, null, 2)}\n`, { mode: 0o600 });
}

/** A config file or a project folder the user adds; ~ is expanded. */
export function addLocation(input: string, home = os.homedir()): string[] {
  const p = path.resolve(expand(input.trim(), home));
  if (!input.trim()) throw new GctkError("INVALID_INPUT", "Enter the path of a config file or a project folder.");
  if (!fs.existsSync(p)) throw new GctkError("INVALID_INPUT", `${p} does not exist.`);
  const list = loadLocations();
  if (!list.includes(p)) saveLocations([...list, p]);
  return loadLocations();
}
export function removeLocation(p: string): string[] {
  saveLocations(loadLocations().filter((x) => x !== p));
  return loadLocations();
}

/** Folders Cursor knows: its workspaces, gctk projects and AXL workshops, added folders. */
export function projectFolders(o: ScanOptions = {}): string[] {
  const home = o.home ?? os.homedir();
  const support = appSupport(home, o.platform ?? process.platform, o.appData);
  const out = new Set<string>();
  const storage = path.join(support, "Cursor", "User", "workspaceStorage");
  for (const d of subdirs(storage)) {
    try {
      const w = JSON.parse(fs.readFileSync(path.join(storage, d, "workspace.json"), "utf8")) as { folder?: string };
      if (w.folder?.startsWith("file://")) out.add(decodeURIComponent(new URL(w.folder).pathname));
    } catch {
      // not a folder workspace
    }
  }
  try {
    for (const w of loadAxlSettings().workshops) if (w.folder) out.add(w.folder);
  } catch {
    // no AXL settings
  }
  for (const l of loadLocations()) if (isDir(l)) out.add(l);
  return [...out].filter(isDir).sort();
}

/** Every Cursor MCP config gctk knows of: the global one, those of known folders, plugins, added files. */
export function configFiles(o: ScanOptions = {}): ConfigFile[] {
  const home = o.home ?? os.homedir();
  const list: Array<Omit<ConfigFile, "exists" | "editable" | "error">> = [{ path: path.join(home, ".cursor", "mcp.json"), editor: "cursor", scope: "user" }];
  for (const dir of projectFolders(o)) list.push({ path: path.join(dir, ".cursor", "mcp.json"), editor: "cursor", scope: "project", project: dir });
  for (const market of subdirs(path.join(home, ".cursor", "plugins", "cache"))) {
    for (const plugin of subdirs(path.join(home, ".cursor", "plugins", "cache", market))) {
      const root = newestDir(path.join(home, ".cursor", "plugins", "cache", market, plugin));
      // Cursor reads the plugin's mcp.json; .mcp.json next to it is Claude Code's (dual-format plugins).
      const f = root && ["mcp.json", ".mcp.json"].map((n) => path.join(root, n)).find((p) => fs.existsSync(p));
      if (f) list.push({ path: f, editor: "cursor", scope: "plugin", plugin });
    }
  }
  for (const l of loadLocations()) if (!isDir(l)) list.push({ path: l, editor: "cursor", scope: "user", added: true });

  const seen = new Set<string>();
  const out: ConfigFile[] = [];
  for (const f of list) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    const exists = fs.existsSync(f.path);
    // Project files that do not exist are noise; the standard and added ones are shown either way.
    if (!exists && f.scope !== "user") continue;
    const r = exists ? readJson(f.path) : { comments: false, error: undefined };
    out.push({ ...f, exists, editable: exists && f.scope !== "plugin" && !r.comments && !r.error, ...(r.error ? { error: r.error } : r.comments ? { error: "has comments; gctk reads it but does not rewrite it" } : {}) });
  }
  return out;
}

// ------------------------------------------------------------------ servers

type Entry = { command?: unknown; args?: unknown; env?: unknown; url?: unknown; headers?: unknown; type?: unknown; disabled?: unknown; [k: string]: unknown };

function sectionsOf(file: ConfigFile, json: Record<string, unknown>): Array<{ section: string; project?: string; servers: Record<string, Entry> }> {
  const out: Array<{ section: string; project?: string; servers: Record<string, Entry> }> = [];
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Entry>) : undefined);
  const main = obj(json.mcpServers) ? "mcpServers" : obj(json.servers) ? "servers" : undefined;
  if (main) out.push({ section: main, project: file.project, servers: obj(json[main])! });
  if (file.editor === "claude-code" && file.scope === "user") {
    for (const [p, cfg] of Object.entries((json.projects as Record<string, { mcpServers?: unknown }>) ?? {})) {
      const s = obj(cfg?.mcpServers);
      if (s && Object.keys(s).length) out.push({ section: `projects:${p}`, project: p, servers: s });
    }
  }
  return out;
}

function shownVars(v: unknown): ShownVar[] {
  if (!v || typeof v !== "object") return [];
  return Object.entries(v as Record<string, unknown>).map(([name, raw]) => {
    const value = String(raw ?? "");
    const secret = isSecretName(name);
    const plain = secret && value !== "" && !isReference(value);
    return { name, value: plain ? mask(value) : value.length > 200 ? `${value.slice(0, 199)}…` : value, secret, plain };
  });
}

interface LaunchRecord {
  id: string;
  server: string;
  file: string;
  section: string;
  command: string;
  /** The command as it was written in the file, for restore. */
  original: string;
  args: string[];
  env: Record<string, string>;
  secretNames: string[];
  account: string;
  clientId?: string;
  cwd?: string;
  pathEnv?: string;
  createdAt: string;
  /** Linked to this org: client ID, secret and region come from the Orgs page at every start. */
  profile?: string;
  /** With profile: the variables that get them. */
  keys?: CredentialKeys;
  signature: string;
}
type Unsigned = Omit<LaunchRecord, "signature">;
const signed = (r: Unsigned) => canonicalJson({ ...r });

function loadRecords(): Record<string, LaunchRecord> {
  try {
    return (JSON.parse(fs.readFileSync(launchFile(), "utf8")) as { records?: Record<string, LaunchRecord> }).records ?? {};
  } catch {
    return {};
  }
}
function saveRecords(records: Record<string, LaunchRecord>): void {
  fs.mkdirSync(gctkHome(), { recursive: true });
  fs.writeFileSync(launchFile(), `${JSON.stringify({ records }, null, 2)}\n`, { mode: 0o600 });
}
const validRecord = (r: LaunchRecord | undefined): r is LaunchRecord => {
  if (!r?.signature) return false;
  const { signature, ...rest } = r;
  try {
    return verify(signed(rest), signature);
  } catch {
    return false;
  }
};

const gctkArgs = (e: Entry) => (Array.isArray(e.args) ? e.args.map(String) : []);
const isGctkJs = (a: string | undefined) => Boolean(a && /gctk\.js$/.test(a));
const launchIdOf = (e: Entry) => {
  const a = gctkArgs(e);
  return isGctkJs(a[0]) && a[1] === "mcp-launch" ? a[2] : undefined;
};

function clientsFromProfiles(): Map<string, string> {
  const m = new Map<string, string>();
  for (const name of listProfiles()) {
    try {
      const creds = loadCredentials(loadProfile(name));
      if (!m.has(creds.clientId)) m.set(creds.clientId, name);
    } catch {
      // no credentials stored
    }
  }
  return m;
}

function regionFrom(env: Record<string, string>): string | undefined {
  for (const [k, v] of Object.entries(env)) {
    if (!v || isReference(v)) continue;
    if (REGION.test(k)) return v.replace(/^https?:\/\/(api|login)\./, "").replace(/\/.*$/, "");
    if (k === "AVA_HABITAT") {
      const region = Object.entries(HABITATS).find(([, h]) => h === v)?.[0];
      if (region) return region;
    }
  }
  return undefined;
}

function credentialKeysOf(names: string[]): CredentialKeys | undefined {
  const clientId = names.find((k) => CLIENT_ID.test(k));
  const secrets = names.filter(isSecretName);
  const secret = secrets.find((k) => /secret/i.test(k)) ?? secrets[0];
  const region = names.find((k) => REGION.test(k));
  const habitat = names.find((k) => k === "AVA_HABITAT");
  if (!clientId && !secret) return undefined;
  return { ...(clientId ? { clientId } : {}), ...(secret ? { secret } : {}), ...(region ? { region } : {}), ...(habitat ? { habitat } : {}) };
}

function describe(file: ConfigFile, section: string, project: string | undefined, name: string, e: Entry, records: Record<string, LaunchRecord>, clients: () => Map<string, string>): ServerInfo {
  const args = gctkArgs(e);
  const rawEnv = e.env && typeof e.env === "object" ? Object.fromEntries(Object.entries(e.env as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")])) : {};
  const launchId = launchIdOf(e);
  const record = launchId ? records[launchId] : undefined;
  const env = shownVars(record ? record.env : e.env);
  if (record) for (const n of record.secretNames) env.push({ name: n, value: "in the keychain", secret: true, plain: false });
  if (record?.profile && record.keys) for (const n of [record.keys.clientId, record.keys.secret, record.keys.region, record.keys.habitat]) if (n) env.push({ name: n, value: `from the org ${record.profile}`, secret: n === record.keys.secret, plain: false });
  const headers = shownVars(e.headers);
  const transport = typeof e.url === "string" || e.type === "http" || e.type === "sse" || e.type === "streamable-http" ? "http" : "stdio";
  const command = typeof e.command === "string" ? e.command : undefined;
  const shownArgs = (record ? record.args : args).map((a) => a.replace(ARG_SECRET, (_m, k: string, v: string) => `${k}${mask(v)}`));
  const linkedNames = record?.keys ? [record.keys.clientId, record.keys.secret, record.keys.region, record.keys.habitat].filter((n): n is string => Boolean(n)) : [];
  const allEnv = record ? { ...record.env, ...Object.fromEntries([...record.secretNames, ...linkedNames].map((n) => [n, ""])) } : rawEnv;
  const genesys = GENESYS.test(name) || GENESYS.test(record?.command ?? command ?? "") || shownArgs.some((a) => GENESYS.test(a)) || Object.keys(allEnv).some((k) => GENESYS_ENV.test(k)) || GENESYS.test(String(e.url ?? ""));
  const problems: Problem[] = [];
  const editable = file.editable;

  let credentials: ServerInfo["credentials"] = "none";
  let org: ServerInfo["org"];
  if (isGctkJs(args[0]) && args[1] === "axl-harness") {
    credentials = "axl";
    const i = args.indexOf("--org");
    org = { profile: i >= 0 ? args[i + 1] : undefined };
  } else if (isGctkJs(args[0]) && args[1] === "project-tool") {
    credentials = "project";
    const i = args.indexOf("--project");
    let profile: string | undefined;
    try {
      profile = loadAxlSettings().workshops.find((w) => w.id === args[i + 1])?.profile;
    } catch {
      profile = undefined;
    }
    org = { profile };
  } else if (record?.profile) {
    credentials = "org";
    let region: string | undefined;
    try {
      region = loadProfile(record.profile).region;
    } catch {
      problems.push({ kind: "launch-invalid", level: "warn", text: `It is linked to the org ${record.profile}, which is no longer on the Orgs page. Link it to another org.`, fix: editable ? "link" : undefined });
    }
    org = { profile: record.profile, region };
  } else if (record || launchId) {
    credentials = "keychain";
    const id = record?.clientId;
    org = { clientId: id ? showClientId(id) : undefined, profile: id ? clients().get(id) : undefined, region: record ? regionFrom(record.env) : undefined };
    if (record && validRecord(record)) problems.push({ kind: "not-linked", level: "info", text: `Its secret is a keychain entry of its own, not one of your orgs, so the Orgs page does not show it.${org.profile ? ` It is the OAuth client of ${org.profile}: link it to that org.` : " Add it as an org and link it."}`, fix: editable ? "link" : undefined });
  } else if ((isGctkJs(args[0]) && (args[1] === "mcp" || args.length === 1)) || /\/dist\/gctk\.js|genesys-cloud-toolkit|diebergziege\/gc-toolkit/.test(args.join(" "))) {
    credentials = "gctk-profile";
    org = rawEnv.GCTK_PROFILE ? { profile: rawEnv.GCTK_PROFILE } : undefined;
  } else {
    const vars = [...env, ...headers];
    if (vars.some((v) => v.plain)) credentials = "plain";
    else if (vars.some((v) => v.secret)) credentials = "reference";
    const idKey = Object.keys(rawEnv).find((k) => CLIENT_ID.test(k));
    const id = idKey && !isReference(rawEnv[idKey]!) ? rawEnv[idKey] : undefined;
    if (genesys && (id || regionFrom(rawEnv))) org = { clientId: id ? showClientId(id) : undefined, profile: id ? clients().get(id) : undefined, region: regionFrom(rawEnv) };
  }

  if (launchId) {
    if (!validRecord(record)) problems.push({ kind: "launch-invalid", level: "warn", text: "This entry starts through gctk, but its launch record is missing or was changed, so gctk will not start it. Remove the entry and add the server again.", fix: editable ? "remove" : undefined });
  }
  for (const v of env.filter((x) => x.plain)) {
    problems.push({ kind: "plain-secret", level: "warn", text: `${v.name} is stored in plain text in this file.`, fix: editable && transport === "stdio" && command ? "keychain" : undefined });
  }
  for (const v of headers.filter((x) => x.plain)) problems.push({ kind: "header-secret", level: "warn", text: `The header ${v.name} holds a secret in plain text. gctk cannot move secrets of remote servers; use your editor's variables (e.g. \${env:NAME}) instead.` });
  if (!record) {
    for (const n of OBSOLETE_ENV) if (n in rawEnv) problems.push({ kind: "obsolete-env", level: "info", text: `${n} was written by an earlier gctk (the removed Chat page); gctk no longer reads it.`, fix: editable ? "clean-env" : undefined });
  }
  const cmd = record?.command ?? command;
  const script = (record?.args ?? args)[0];
  // gctk's own entry point first: a plugin update deletes the version folder it pointed to.
  const own = viaGctk(command, args);
  if (own && !fs.existsSync(own)) problems.push({ kind: "missing-command", level: "warn", text: `It starts through gctk at ${own}, which no longer exists (gctk was updated, moved or removed). Repair points it to the copy of gctk that stays across updates.`, fix: editable ? "repair" : undefined });
  else if (args.some((x) => OLD_PACKAGE.test(x))) problems.push({ kind: "old-package", level: "info", text: "It loads gctk as github:…, which needs git on the computer and takes much longer to start. Repair switches it to the download link that needs no git.", fix: editable ? "repair" : undefined });
  else if (own && args[1] !== "mcp" && path.resolve(own) !== path.resolve(stableGctkJs())) problems.push({ kind: "unstable-path", level: "info", text: `It starts gctk from ${own}, a folder of this computer only (a development checkout or a plugin version an update deletes). Repair points it to ${stableGctkJs()}, which every computer with gctk has.`, fix: editable ? "repair" : undefined });
  else if (transport === "stdio" && cmd && path.isAbsolute(cmd) && !fs.existsSync(cmd)) problems.push({ kind: "missing-command", level: "warn", text: `The command ${cmd} does not exist; the editor cannot start this server.`, fix: editable ? "remove" : undefined });
  else if (transport === "stdio" && script && path.isAbsolute(script) && /\.(c|m)?js$/.test(script) && !fs.existsSync(script)) problems.push({ kind: "missing-command", level: "warn", text: `The script ${script} no longer exists (an older version, moved or deleted).`, fix: editable ? "remove" : undefined });
  if (genesys && org?.clientId && !org.profile) problems.push({ kind: "unknown-client", level: "info", text: `The OAuth client ${org.clientId} is not one of your gctk profiles, so gctk cannot tell which org it is.` });

  return {
    key: keyOf({ file: file.path, section, name }),
    file: file.path,
    section,
    name,
    editor: file.editor,
    scope: section.startsWith("projects:") ? "project" : file.scope,
    project,
    plugin: file.plugin,
    editable,
    transport,
    command: record ? record.command : command,
    args: shownArgs,
    url: typeof e.url === "string" ? e.url.replace(/([?&](token|key|secret|api_key)=)[^&]+/gi, "$1••••") : undefined,
    env,
    headers,
    disabled: e.disabled === true,
    genesys,
    credentials,
    org,
    launch: launchId ? { id: launchId, account: record?.account ?? "", valid: validRecord(record), secretNames: record?.secretNames ?? [] } : undefined,
    ...(() => {
      if (!genesys || !editable || transport !== "stdio" || credentials === "gctk-profile" || credentials === "axl" || credentials === "project" || (launchId && !validRecord(record))) return {};
      const keys = record?.keys ?? credentialKeysOf(record ? [...Object.keys(record.env), ...record.secretNames] : Object.keys(rawEnv));
      if (!keys) return {};
      // Linkable: the secret is readable here (in the file or a keychain entry of its own), or the client ID names an org.
      const canLink = credentials !== "org" && keys.clientId && keys.secret && (credentials === "plain" || credentials === "keychain" || org?.profile);
      return { credentialKeys: keys, ...(canLink ? { linkOrg: { ...(org?.profile ? { match: org.profile } : {}), ...(org?.region ? { region: org.region } : {}) } } : {}) };
    })(),
    problems,
  };
}

/** Plain secrets that are written into several files: rotating them means editing each file. */
function markDuplicates(servers: ServerInfo[], hashes: Map<string, string[]>): void {
  for (const s of servers) {
    const mine = hashes.get(s.key) ?? [];
    const others = new Set<string>();
    for (const o of servers) if (o.key !== s.key && (hashes.get(o.key) ?? []).some((h) => mine.includes(h))) others.add(o.file === s.file ? `${o.name} in the same file` : o.file);
    if (others.size) s.problems.push({ kind: "same-secret", level: "warn", text: `The same secret is also written in: ${[...others].join(", ")}. A new secret then has to be entered in each of them; in the keychain it is one entry.` });
  }
}

export function scanAiSetup(o: ScanOptions = {}): AiSetup {
  const files = configFiles(o);
  const records = loadRecords();
  let cache: Map<string, string> | undefined;
  const clients = () => (cache ??= (o.clients ?? clientsFromProfiles)());
  const servers: ServerInfo[] = [];
  const hashes = new Map<string, string[]>();
  for (const f of files) {
    if (!f.exists || (f.error && !f.editable && !/comments/.test(f.error))) continue;
    const json = readJson(f.path).value;
    if (!json) continue;
    for (const { section, project, servers: entries } of sectionsOf(f, json)) {
      for (const [name, e] of Object.entries(entries)) {
        if (!e || typeof e !== "object") continue;
        const s = describe(f, section, project, name, e, records, clients);
        servers.push(s);
        const env = e.env && typeof e.env === "object" ? Object.entries(e.env as Record<string, unknown>) : [];
        hashes.set(s.key, env.filter(([k, v]) => isSecretName(k) && typeof v === "string" && v && !isReference(v)).map(([, v]) => sha(String(v))));
      }
    }
  }
  markDuplicates(servers, hashes);
  const store = o.store ?? keychainStore;
  const byAccount = new Map<string, ManagedSecret>();
  for (const r of Object.values(records)) {
    if (!r.account) continue;
    const m = byAccount.get(r.account) ?? { account: r.account, names: [], usedBy: [], stored: false, clientId: r.clientId ? showClientId(r.clientId) : undefined, profile: r.clientId ? clients().get(r.clientId) : undefined };
    m.names = [...new Set([...m.names, ...r.secretNames])];
    m.usedBy.push({ id: r.id, server: r.server, file: r.file });
    byAccount.set(r.account, m);
  }
  for (const m of byAccount.values()) {
    try {
      m.stored = Boolean(store.get(m.account));
    } catch {
      m.stored = false;
    }
  }
  return { files, servers, secrets: [...byAccount.values()], locations: loadLocations(), removedSkills: listRemovedSkills() };
}

// ------------------------------------------------- skills removed earlier

const removedDir = () => path.join(gctkHome(), "removed-skills");

/** Moves a folder or link; across volumes (e.g. a cloud drive) by copying, links stay links. */
function move(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    if (fs.lstatSync(from).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

export function listRemovedSkills(): RemovedSkill[] {
  if (!fs.existsSync(removedDir())) return [];
  const out: RemovedSkill[] = [];
  for (const id of fs.readdirSync(removedDir())) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(removedDir(), id, "removed.json"), "utf8")) as RemovedSkill);
    } catch {
      // not one of ours
    }
  }
  return out.sort((a, b) => b.removedAt.localeCompare(a.removedAt));
}

export function restoreSkill(id: string): RemovedSkill {
  const r = listRemovedSkills().find((x) => x.id === id);
  if (!r) throw new GctkError("INVALID_INPUT", "Unknown removed skill.");
  if (fs.existsSync(r.from) || isLink(r.from)) throw new GctkError("INVALID_INPUT", `There is a skill at ${r.from} again; remove it first.`);
  move(path.join(removedDir(), id, path.basename(r.from)), r.from);
  fs.rmSync(path.join(removedDir(), id), { recursive: true, force: true });
  return r;
}
const isLink = (p: string) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

// ------------------------------------------------------------ project tools

/** A Genesys MCP server from the user's configs that a project folder can get (see axl.ts ProjectTool). */
export interface ToolTemplate {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  keys: { clientId: string; secret: string; region?: string; habitat?: string };
  /** Where it was found. */
  from: string;
  editor: Editor;
}


/**
 * Genesys servers the user already runs, as templates for project folders: the program and its
 * settings, never a credential (the project's org fills those in at every start). The AVA harness is
 * built in and gctk's own servers start through gctk already, so neither is offered.
 */
export function toolTemplates(o: ScanOptions = {}): ToolTemplate[] {
  const records = loadRecords();
  const out = new Map<string, ToolTemplate & { plugin: boolean }>();
  for (const f of configFiles(o)) {
    if (!f.exists) continue;
    const json = readJson(f.path).value;
    if (!json) continue;
    for (const { servers } of sectionsOf(f, json)) {
      for (const [name, e] of Object.entries(servers)) {
        if (name === "ava-harness" || typeof e.command !== "string" || typeof e.url === "string") continue;
        const args = gctkArgs(e);
        const launchId = launchIdOf(e);
        const record = launchId ? records[launchId] : undefined;
        if (launchId && !validRecord(record)) continue;
        if (!record && isGctkJs(args[0])) continue;
        const rawEnv = record ? record.env : Object.fromEntries(Object.entries((e.env as Record<string, unknown>) ?? {}).map(([k, v]) => [k, String(v ?? "")]));
        const names = record ? [...Object.keys(record.env), ...record.secretNames] : Object.keys(rawEnv);
        const keys = credentialKeysOf(names);
        const command = record?.command ?? e.command;
        const genesys = GENESYS.test(name) || GENESYS.test(command) || names.some((k) => GENESYS_ENV.test(k));
        if (!genesys || !keys?.clientId || !keys.secret) continue;
        let resolved: string;
        try {
          resolved = record ? record.command : resolveCommand(e.command, rawEnv);
        } catch {
          continue;
        }
        const cmdArgs = record ? record.args : args;
        const used = [keys.clientId, keys.secret, keys.region, keys.habitat].filter(Boolean);
        const env = Object.fromEntries(Object.entries(rawEnv).filter(([k, v]) => !used.includes(k) && !isSecretName(k) && !isReference(v)));
        // One template per tool: the user's own config before a plugin's (a plugin path names its version, which an update deletes).
        const prev = out.get(name);
        if (prev && !(prev.plugin && f.scope !== "plugin")) continue;
        const id = sha(`${name}\n${resolved}\n${cmdArgs.join("\u0000")}`).slice(0, 12);
        out.set(name, { id, name, command: resolved, args: cmdArgs, env, keys: keys as ToolTemplate["keys"], from: f.path, editor: f.editor, plugin: f.scope === "plugin" });
      }
    }
  }
  return [...out.values()].map(({ plugin: _p, ...t }) => t).sort((a, b) => a.name.localeCompare(b.name));
}

// --------------------------------------------------------------------- fixes

function locate(a: ServerAddress, o: ScanOptions = {}): { file: ConfigFile; json: Record<string, unknown>; indent: string | number; servers: Record<string, Entry>; entry: Entry } {
  const file = configFiles(o).find((f) => f.path === a.file);
  if (!file) throw new GctkError("INVALID_INPUT", `${a.file} is not one of the config files on the Cursor setup page.`);
  if (!file.editable) throw new GctkError("INVALID_INPUT", `gctk does not change ${a.file}${file.error ? ` (${file.error})` : file.scope === "plugin" ? " (it belongs to a plugin)" : ""}.`);
  const r = readJson(a.file);
  if (!r.value) throw new GctkError("INVALID_INPUT", `${a.file} could not be read: ${r.error}.`);
  const section = sectionsOf(file, r.value).find((s) => s.section === a.section);
  const entry = section?.servers[a.name];
  if (!section || !entry) throw new GctkError("INVALID_INPUT", `${a.file} has no server "${a.name}" (any more).`);
  return { file, json: r.value, indent: r.indent, servers: section.servers, entry };
}


function resolveCommand(cmd: string, env: Record<string, string>): string {
  if (path.isAbsolute(cmd)) {
    if (!fs.existsSync(cmd)) throw new GctkError("INVALID_INPUT", `The command ${cmd} does not exist.`);
    return cmd;
  }
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const dir of (env.PATH ?? process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {
        // next
      }
    }
  }
  throw new GctkError("INVALID_INPUT", `gctk could not find the command "${cmd}" on this computer.`);
}

/**
 * Moves the plain-text secrets of a stdio server into the keychain. The entry then starts
 * `node <gctk.js> mcp-launch <id>`; command, arguments and variables live in the signed record.
 * The same secrets in another entry reuse the keychain item, so a new secret is entered once.
 */
export function moveToKeychain(a: ServerAddress, opts: { gctkJs: string; node?: string; store?: SecretStore } & ScanOptions): { id: string; account: string } {
  const store = opts.store ?? keychainStore;
  const { file, json, indent, servers, entry } = locate(a, opts);
  if (launchIdOf(entry)) throw new GctkError("INVALID_INPUT", `${a.name} already starts through gctk.`);
  if (typeof entry.command !== "string" || typeof entry.url === "string") throw new GctkError("INVALID_INPUT", `${a.name} is not started as a program on this computer; gctk can only move secrets of such servers.`);
  const env = Object.fromEntries(Object.entries((entry.env as Record<string, unknown>) ?? {}).map(([k, v]) => [k, String(v ?? "")]));
  const secretNames = Object.keys(env).filter((k) => isSecretName(k) && env[k] && !isReference(env[k]!));
  if (!secretNames.length) throw new GctkError("INVALID_INPUT", `${a.name} has no secret in plain text.`);
  const secrets = Object.fromEntries(secretNames.map((k) => [k, env[k]!]));
  const rest = Object.fromEntries(Object.entries(env).filter(([k]) => !secretNames.includes(k)));
  const command = resolveCommand(entry.command, env);
  const records = loadRecords();
  const value = canonicalJson(secrets);
  const reuse = [...new Set(Object.values(records).map((r) => r.account))].find((acc) => {
    try {
      const v = store.get(acc);
      return v !== undefined && canonicalJson(JSON.parse(v)) === value;
    } catch {
      return false;
    }
  });
  const id = crypto.randomBytes(6).toString("hex");
  const account = reuse ?? `__mcp__${id}`;
  if (!reuse) store.set(account, JSON.stringify(secrets));
  const clientKey = Object.keys(rest).find((k) => CLIENT_ID.test(k));
  const unsigned: Unsigned = {
    id,
    server: a.name,
    file: a.file,
    section: a.section,
    command,
    original: entry.command,
    args: gctkArgs(entry),
    env: rest,
    secretNames,
    account,
    ...(clientKey ? { clientId: rest[clientKey] } : {}),
    ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : file.scope === "project" && file.project ? { cwd: file.project } : {}),
    pathEnv: env.PATH ?? process.env.PATH ?? "",
    createdAt: new Date().toISOString(),
  };
  const { env: _env, cwd: _cwd, ...keep } = entry;
  servers[a.name] = { ...keep, command: opts.node ?? process.execPath, args: [opts.gctkJs, "mcp-launch", id] };
  // Either all three exist (keychain item, record, rewritten entry) or none: no orphaned secret.
  try {
    saveRecords({ ...records, [id]: { ...unsigned, signature: sign(signed(unsigned)) } });
    writeJson(a.file, json, indent);
  } catch (err) {
    try {
      saveRecords(records);
    } catch {
      // the record was never written
    }
    if (!reuse) store.remove(account);
    throw err;
  }
  return { id, account };
}

function dropRecord(id: string, store: SecretStore): void {
  const records = loadRecords();
  const r = records[id];
  if (!r) return;
  delete records[id];
  saveRecords(records);
  if (r.account && !Object.values(records).some((x) => x.account === r.account)) {
    try {
      store.remove(r.account);
    } catch {
      // already gone
    }
  }
}

/** Puts the secrets back into the file and the original command back into the entry. */
export function restoreToFile(a: ServerAddress, opts: { store?: SecretStore; orgs?: OrgStore } & ScanOptions = {}): void {
  const store = opts.store ?? keychainStore;
  const { json, indent, servers, entry } = locate(a, opts);
  const id = launchIdOf(entry);
  const r = id ? loadRecords()[id] : undefined;
  if (!id || !validRecord(r)) throw new GctkError("INVALID_INPUT", `${a.name} does not start through gctk with a valid launch record.`);
  const raw = r.account ? store.get(r.account) : "{}";
  if (!raw) throw new GctkError("INVALID_INPUT", "The secret is no longer in the keychain. Enter it again under Secrets in the keychain, then restore.");
  const secrets = { ...(JSON.parse(raw) as Record<string, string>), ...(r.profile ? orgValues(r, opts.orgs ?? keychainOrgs) : {}) };
  const names = [...r.secretNames, ...(r.keys ? [r.keys.clientId, r.keys.secret, r.keys.region, r.keys.habitat].filter((n): n is string => Boolean(n)) : [])];
  const { command: _c, args: _a, ...keep } = entry;
  servers[a.name] = { ...keep, command: r.original, ...(r.args.length ? { args: r.args } : {}), env: { ...r.env, ...Object.fromEntries(names.map((n) => [n, secrets[n] ?? ""])) } };
  writeJson(a.file, json, indent);
  dropRecord(id, store);
}

/** How Cursor starts gctk from GitHub without git (npm needs git for github: packages). */
export const GCTK_PACKAGE = "https://github.com/diebergziege/gc-toolkit/archive/refs/heads/main.tar.gz";
const OLD_PACKAGE = /^github:diebergziege\/(gc-toolkit|genesys-cloud-toolkit)(#.*)?$/;

/** The gctk.js an entry gctk wrote starts (node <gctk.js> mcp-launch|axl-harness|mcp …), if it is one. */
function viaGctk(command: string | undefined, args: string[]): string | undefined {
  const [js, sub] = args;
  return command && js && path.isAbsolute(js) && /gctk\.js$/.test(js) && ["mcp-launch", "axl-harness", "project-tool", "mcp"].includes(sub ?? "") ? js : undefined;
}

/** Points an entry gctk wrote to a gctk.js that exists (the stable copy) and node, nothing else changes. */
export function repairServer(a: ServerAddress, opts: { gctkJs: string; node?: string } & ScanOptions): void {
  const { json, indent, servers, entry } = locate(a, opts);
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  if (args.some((x) => OLD_PACKAGE.test(x))) {
    servers[a.name] = { ...entry, args: args.map((x) => (OLD_PACKAGE.test(x) ? GCTK_PACKAGE : x)) };
    writeJson(a.file, json, indent);
    return;
  }
  if (!viaGctk(typeof entry.command === "string" ? entry.command : undefined, args)) throw new GctkError("INVALID_INPUT", `${a.name} does not start through gctk.`);
  const node = typeof entry.command === "string" && fs.existsSync(entry.command) ? entry.command : opts.node ?? process.execPath;
  servers[a.name] = { ...entry, command: node, args: [opts.gctkJs, ...args.slice(1)] };
  writeJson(a.file, json, indent);
}

export function removeServer(a: ServerAddress, opts: { store?: SecretStore } & ScanOptions = {}): void {
  const { json, indent, servers, entry } = locate(a, opts);
  const id = launchIdOf(entry);
  delete servers[a.name];
  writeJson(a.file, json, indent);
  if (id) dropRecord(id, opts.store ?? keychainStore);
}

/** Removes variables gctk wrote earlier and no longer reads (OBSOLETE_ENV). */
export function cleanEnv(a: ServerAddress, opts: ScanOptions = {}): string[] {
  const { json, indent, entry } = locate(a, opts);
  const env = (entry.env as Record<string, unknown>) ?? {};
  const gone = OBSOLETE_ENV.filter((n) => n in env);
  if (!gone.length) return [];
  for (const n of gone) delete env[n];
  writeJson(a.file, json, indent);
  return gone;
}

/** A new secret (e.g. after rotating the OAuth client) for every server using this keychain item. */
export function updateSecret(account: string, values: Record<string, unknown>, store: SecretStore = keychainStore): void {
  const users = Object.values(loadRecords()).filter((r) => r.account === account);
  if (!users.length) throw new GctkError("INVALID_INPUT", "Unknown keychain item.");
  const names = [...new Set(users.flatMap((r) => r.secretNames))];
  const next: Record<string, string> = {};
  for (const n of names) {
    const v = values[n];
    if (typeof v !== "string" || !v.trim()) throw new GctkError("INVALID_INPUT", `Enter a value for ${n}.`);
    next[n] = v.trim();
  }
  store.set(account, JSON.stringify(next));
}

export interface CredentialInput {
  /** Take client ID, secret and region from this gctk profile (secret read from the keychain here). */
  profile?: string;
  clientId?: string;
  /** Empty: keep the current secret. */
  secret?: string;
  region?: string;
  /** Plain entries: store the secret in the keychain (default) instead of the file. */
  keychain?: boolean;
}

/**
 * New Genesys credentials for a server: entered, or those of a gctk org. A keychain-started server
 * keeps its config entry; its record and keychain item change (a shared item is split off, so other
 * servers keep theirs). A plain entry gets the values in the file, the secret then moves to the keychain.
 */
export function setCredentials(a: ServerAddress, input: CredentialInput, opts: { gctkJs?: string; node?: string; store?: SecretStore } & ScanOptions = {}): void {
  const store = opts.store ?? keychainStore;
  let v: { clientId?: string; secret?: string; region?: string };
  if (input.profile) {
    // An org from the Orgs page: link to it, so its credentials stay in one place.
    if (!opts.gctkJs) throw new GctkError("INVALID_INPUT", "Linking to an org needs the installed gctk (dist/gctk.js).");
    linkToOrg(a, { ...opts, gctkJs: opts.gctkJs, profile: input.profile, useOrgSecret: true });
    return;
  } else {
    v = { clientId: input.clientId?.trim() || undefined, secret: input.secret?.trim() || undefined, region: input.region?.trim() ? resolveRegion(input.region.trim()) : undefined };
  }
  if (!v.clientId && !v.secret && !v.region) throw new GctkError("INVALID_INPUT", "Enter what should change, or choose an org.");
  const { json, indent, entry } = locate(a, opts);
  if (typeof entry.command !== "string" || typeof entry.url === "string") throw new GctkError("INVALID_INPUT", `${a.name} is not started as a program on this computer.`);
  const apply = (env: Record<string, string>, keys: CredentialKeys) => {
    if (v.clientId) {
      if (!keys.clientId) throw new GctkError("INVALID_INPUT", `${a.name} has no client ID variable.`);
      env[keys.clientId] = v.clientId;
    }
    if (v.region && keys.region) env[keys.region] = v.region;
    if (v.region && keys.habitat && HABITATS[v.region]) env[keys.habitat] = HABITATS[v.region]!;
  };

  const id = launchIdOf(entry);
  if (id) {
    const records = loadRecords();
    const r = records[id];
    if (!validRecord(r)) throw new GctkError("INVALID_INPUT", `${a.name} starts through gctk, but its launch record is missing or was changed.`);
    if (r.profile) throw new GctkError("INVALID_INPUT", `${a.name} is linked to the org ${r.profile}: change that org on the Orgs page, or link ${a.name} to another org.`);
    const keys = credentialKeysOf([...Object.keys(r.env), ...r.secretNames]);
    if (!keys) throw new GctkError("INVALID_INPUT", `${a.name} has no Genesys credential variables.`);
    const env = { ...r.env };
    apply(env, keys);
    let account = r.account;
    if (v.secret) {
      if (!keys.secret || !r.secretNames.includes(keys.secret)) throw new GctkError("INVALID_INPUT", `${a.name} has no secret variable.`);
      const current = JSON.parse(store.get(r.account) ?? "{}") as Record<string, string>;
      if (Object.values(records).some((x) => x.id !== id && x.account === r.account)) account = `__mcp__${crypto.randomBytes(6).toString("hex")}`;
      store.set(account, JSON.stringify({ ...current, [keys.secret]: v.secret }));
    }
    const { signature: _s, ...rest } = r;
    const unsigned: Unsigned = { ...rest, env, account, ...(keys.clientId && env[keys.clientId] ? { clientId: env[keys.clientId] } : {}) };
    saveRecords({ ...records, [id]: { ...unsigned, signature: sign(signed(unsigned)) } });
    return;
  }

  const env = Object.fromEntries(Object.entries((entry.env as Record<string, unknown>) ?? {}).map(([k, x]) => [k, String(x ?? "")]));
  const keys = credentialKeysOf(Object.keys(env));
  if (!keys) throw new GctkError("INVALID_INPUT", `${a.name} has no Genesys credential variables.`);
  apply(env, keys);
  if (v.secret) {
    if (!keys.secret) throw new GctkError("INVALID_INPUT", `${a.name} has no secret variable.`);
    env[keys.secret] = v.secret;
  }
  entry.env = env;
  writeJson(a.file, json, indent);
  const secret = keys.secret ? env[keys.secret] : undefined;
  if (input.keychain !== false && secret && !isReference(secret)) {
    if (!opts.gctkJs) throw new GctkError("INVALID_INPUT", "Saved in the file. Moving the secret to the keychain needs the installed gctk (dist/gctk.js).");
    moveToKeychain(a, { ...opts, gctkJs: opts.gctkJs });
  }
}

/** The linked org's credentials in the variables the record names. */
function orgValues(r: LaunchRecord, orgs: OrgStore): Record<string, string> {
  if (!r.profile || !r.keys) return {};
  let p: Profile;
  try {
    p = loadProfile(r.profile);
  } catch {
    throw new GctkError("MCP_LAUNCH", `${r.server} is linked to the org ${r.profile}, which is no longer on the Orgs page. Link it to another org on the Cursor setup page of the gctk UI.`);
  }
  const c = orgs.load(p);
  const out: Record<string, string> = {};
  if (r.keys.clientId) out[r.keys.clientId] = c.clientId;
  if (r.keys.secret) out[r.keys.secret] = c.clientSecret;
  if (r.keys.region) out[r.keys.region] = p.region;
  if (r.keys.habitat && HABITATS[p.region]) out[r.keys.habitat] = HABITATS[p.region]!;
  return out;
}

export interface LinkInput {
  /** An org on the Orgs page; without it, the org whose OAuth client the entry uses. */
  profile?: string;
  /** Add the entry's credentials as a new org (its region from the entry unless given). */
  newOrg?: { name: string; tier: Tier; region?: string; description?: string };
  /** The entry's secret differs from the org's: use the org's anyway. */
  useOrgSecret?: boolean;
}

/**
 * Links a Genesys server to an org on the Orgs page, so the Orgs page is the one place for OAuth
 * credentials: the entry then starts `gctk mcp-launch <id>`, whose signed record names the org and
 * the variables, and gets client ID, secret and region from that org at every start. The secret it
 * had (in the file or a keychain entry of its own) becomes a new org, or is dropped for the org that
 * has the same OAuth client. Other secrets of the server stay in a keychain entry of its own.
 */
export function linkToOrg(a: ServerAddress, input: LinkInput & { gctkJs: string; node?: string; store?: SecretStore } & ScanOptions): { profile: string; created: boolean } {
  const store = input.store ?? keychainStore;
  const orgs = input.orgs ?? keychainOrgs;
  const { file, json, indent, servers, entry } = locate(a, input);
  if (typeof entry.command !== "string" || typeof entry.url === "string") throw new GctkError("INVALID_INPUT", `${a.name} is not started as a program on this computer.`);
  const records = loadRecords();
  const oldId = launchIdOf(entry);
  const old = oldId ? records[oldId] : undefined;
  if (oldId && !validRecord(old)) throw new GctkError("INVALID_INPUT", `${a.name} starts through gctk, but its launch record is missing or was changed. Remove the entry and add the server again.`);

  // What the server has now: settings, secrets, program.
  let env: Record<string, string>;
  let secrets: Record<string, string>;
  let base: Pick<Unsigned, "command" | "original" | "args" | "cwd" | "pathEnv">;
  if (old) {
    env = { ...old.env };
    secrets = old.account ? (JSON.parse(store.get(old.account) ?? "{}") as Record<string, string>) : {};
    base = { command: old.command, original: old.original, args: old.args, ...(old.cwd ? { cwd: old.cwd } : {}), ...(old.pathEnv !== undefined ? { pathEnv: old.pathEnv } : {}) };
  } else {
    const raw = Object.fromEntries(Object.entries((entry.env as Record<string, unknown>) ?? {}).map(([k, v]) => [k, String(v ?? "")]));
    secrets = Object.fromEntries(Object.entries(raw).filter(([k, v]) => isSecretName(k) && v && !isReference(v)));
    env = Object.fromEntries(Object.entries(raw).filter(([k]) => !(k in secrets)));
    base = { command: resolveCommand(entry.command, raw), original: entry.command, args: gctkArgs(entry), ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : file.scope === "project" && file.project ? { cwd: file.project } : {}), pathEnv: raw.PATH ?? process.env.PATH ?? "" };
  }
  const keys = old?.keys ?? credentialKeysOf([...Object.keys(env), ...Object.keys(secrets), ...(old?.secretNames ?? [])]);
  if (!keys?.clientId || !keys.secret) throw new GctkError("INVALID_INPUT", `${a.name} has no Genesys client ID and secret variables, so it cannot be linked to an org.`);
  const fileClient = env[keys.clientId] && !isReference(env[keys.clientId]!) ? env[keys.clientId] : old?.clientId;
  const fileSecret = secrets[keys.secret];
  const fileRegion = regionFrom(env);

  // The org.
  let profile: Profile;
  let created = false;
  if (input.newOrg) {
    const name = input.newOrg.name.trim();
    assertProfileName(name);
    if (listProfiles().includes(name)) throw new GctkError("PROFILE_EXISTS", `An org "${name}" exists already; choose another name, or link to it.`);
    if (!TIERS.includes(input.newOrg.tier)) throw new GctkError("INVALID_INPUT", `Unknown tier "${input.newOrg.tier}".`);
    const region = input.newOrg.region?.trim() ? resolveRegion(input.newOrg.region.trim()) : fileRegion;
    if (!region) throw new GctkError("INVALID_INPUT", "Enter the org's region (the domain you log in with, e.g. mypurecloud.de).");
    if (!fileClient || !fileSecret) throw new GctkError("INVALID_INPUT", `gctk cannot read ${a.name}'s client ID and secret, so it cannot add them as an org.`);
    profile = { name, region, tier: input.newOrg.tier, credentials: "keychain", ...(input.newOrg.description ? { description: input.newOrg.description } : {}) };
  } else {
    const clients = input.clients ?? clientsFromProfiles;
    const name = input.profile ?? (fileClient ? clients().get(fileClient) : undefined);
    if (!name) throw new GctkError("ORG_UNKNOWN", `${a.name}'s OAuth client is not one of your orgs. Add it as an org.`);
    profile = loadProfile(name);
    const c = orgs.load(profile);
    if (!input.useOrgSecret && fileClient === c.clientId && fileSecret && fileSecret !== c.clientSecret) {
      throw new GctkError("SECRET_DIFFERS", `${a.name} has a different secret than the org ${name} for the same OAuth client. One of them is out of date (rotated?).`);
    }
  }

  const id = oldId ?? crypto.randomBytes(6).toString("hex");
  const credentialNames = [keys.clientId, keys.secret, keys.region, keys.habitat].filter((n): n is string => Boolean(n));
  const others = Object.fromEntries(Object.entries(secrets).filter(([k]) => !credentialNames.includes(k)));
  const account = Object.keys(others).length ? (old?.account && Object.values(records).every((x) => x.id === id || x.account !== old.account) ? old.account : `__mcp__${id}`) : "";
  const unsigned: Unsigned = {
    id,
    server: a.name,
    file: a.file,
    section: a.section,
    ...base,
    env: Object.fromEntries(Object.entries(env).filter(([k]) => !credentialNames.includes(k))),
    secretNames: Object.keys(others),
    account,
    profile: profile.name,
    keys,
    createdAt: new Date().toISOString(),
  };
  const { env: _e, cwd: _c, ...keep } = entry;
  servers[a.name] = { ...keep, command: input.node ?? process.execPath, args: [input.gctkJs, "mcp-launch", id] };
  // The org, the record and the file change together, or none of them.
  const before = { ...records };
  let profileSaved = false;
  try {
    if (input.newOrg) {
      saveProfile(profile);
      profileSaved = true;
      orgs.save(profile, { clientId: fileClient!, clientSecret: fileSecret! });
      created = true;
    }
    if (account) store.set(account, JSON.stringify(others));
    saveRecords({ ...records, [id]: { ...unsigned, signature: sign(signed(unsigned)) } });
    writeJson(a.file, json, indent);
  } catch (err) {
    try {
      saveRecords(before);
    } catch {
      // the record was never written
    }
    if (account && account !== old?.account) store.remove(account);
    if (created) orgs.remove(profile.name);
    if (profileSaved) removeProfile(profile.name);
    throw err;
  }
  // The keychain entry of its own is no longer needed once no record uses it.
  if (old?.account && old.account !== account && !Object.values(loadRecords()).some((x) => x.account === old.account)) {
    try {
      store.remove(old.account);
    } catch {
      // already gone
    }
  }
  return { profile: profile.name, created };
}

// ------------------------------------------------------------------ launcher

/** Variables the editor may pass through to the server; everything else comes from the signed record. */
const PASS_THROUGH = /^(LANG|LC_[A-Z]+|TERM|TZ|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy)$/;

/** Environment and command for `gctk mcp-launch <id>`; refuses unsigned or edited records. */
export function launchSpec(id: string, base: NodeJS.ProcessEnv = process.env, store: SecretStore = keychainStore, orgs: OrgStore = keychainOrgs): { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string; record: LaunchRecord } {
  const r = loadRecords()[id];
  if (!validRecord(r)) throw new GctkError("MCP_LAUNCH", `No valid launch record "${id}". Open the Cursor setup page of the gctk UI and set the server up again.`);
  const raw = r.account ? store.get(r.account) : "{}";
  if (!raw) throw new GctkError("MCP_LAUNCH", `The secret of ${r.server} is not in the keychain. Enter it on the Cursor setup page of the gctk UI.`);
  const secrets = JSON.parse(raw) as Record<string, string>;
  const fromOrg = r.profile ? orgValues(r, orgs) : {};
  const user = os.userInfo();
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(base).filter(([k]) => PASS_THROUGH.test(k))),
    HOME: os.homedir(),
    USER: user.username,
    LOGNAME: user.username,
    TMPDIR: os.tmpdir(),
    PATH: r.pathEnv ?? "",
    ...r.env,
    ...Object.fromEntries(r.secretNames.map((n) => [n, secrets[n] ?? ""])),
    ...fromOrg,
  };
  return { command: r.command, args: r.args, env, ...(r.cwd ? { cwd: r.cwd } : {}), record: r };
}

/** `gctk mcp-launch <id>`: runs the server on stdio for the editor. Nothing else writes to stdout. */
export async function runLaunch(id: string): Promise<number> {
  const { command, args, env, cwd } = launchSpec(id);
  const child = spawn(command, args, { stdio: "inherit", env, ...(cwd && isDir(cwd) ? { cwd } : {}) });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

// -------------------------------------------------------------------- report

const CRED_TEXT: Record<ServerInfo["credentials"], string> = {
  none: "no credentials",
  plain: "secret in plain text in the file",
  reference: "secret from a variable",
  keychain: "secret in a keychain entry of its own (started through gctk)",
  org: "linked to an org on the Orgs page (started through gctk)",
  "gctk-profile": "gctk profiles (keychain)",
  axl: "AXL workshop org (keychain, through gctk)",
  project: "gctk project org (keychain, through gctk)",
};

/** What gc_ai_setup tells the AI: Cursor's MCP servers (Genesys first) and their problems; secrets masked. */
export function formatAiSetup(s: AiSetup): string {
  const where = (x: ServerInfo) => (x.scope === "project" ? `folder ${x.project}` : x.scope === "plugin" ? `plugin ${x.plugin}` : "every folder (~/.cursor/mcp.json)");
  const line = (x: ServerInfo) =>
    [
      `- ${x.name}${x.disabled ? " (disabled)" : ""} · ${where(x)} · ${x.file}`,
      `  ${x.transport === "http" ? `url ${x.url}` : `command ${x.command ?? "?"} ${x.args.join(" ")}`.trim()}`,
      `  credentials: ${CRED_TEXT[x.credentials]}${x.org ? ` · org: ${x.org.profile ? `gctk profile ${x.org.profile}` : "unknown profile"}${x.org.region ? `, region ${x.org.region}` : ""}${x.org.clientId ? `, client ${x.org.clientId}` : ""}` : ""}`,
      ...x.problems.map((p) => `  ${p.level === "warn" ? "WARNING" : "note"}: ${p.text}`),
    ].join("\n");
  const genesys = s.servers.filter((x) => x.genesys);
  const other = s.servers.filter((x) => !x.genesys);
  return [
    `Cursor: ${s.servers.length} MCP server(s) in ${s.files.filter((f) => f.exists).length} config file(s); ${genesys.length} talk to Genesys Cloud. Secrets are masked. Fixes (moving a secret to the keychain, another org, removing an entry) are the user's: they press them on the Cursor setup page of the gctk UI (gc_ui page ai-setup); a folder's own org and tools are set on the Projects page.`,
    "",
    "Genesys Cloud servers:",
    ...(genesys.length ? genesys.map(line) : ["- none"]),
    "",
    "Other servers:",
    ...(other.length ? other.map(line) : ["- none"]),
  ].join("\n");
}
