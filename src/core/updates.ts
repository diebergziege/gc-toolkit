import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GCTK_PACKAGE, type ServerInfo } from "./ai-setup.js";
import { harnessCommandOf, loadAxlSettings } from "./axl.js";
import { GctkError } from "./errors.js";
import { olderVersion, runningGctkJs, stableGctkJs } from "./stable-gctk.js";

/**
 * Updates of the programs behind the MCP servers of Cursor and the Claude app (UI pages "Cursor setup"
 * and "Claude app", a click only, never an MCP tool). An ava-harness started through gctk (workshops,
 * the Claude app) runs the AVA harness command of the Projects page. gctk knows two ways they get installed:
 * - uv tools (ava-mcp): the receipt in uv's tool folder names the source, a GitHub release wheel or a
 *   PyPI package. An update installs the newest release the same way; for ava-mcp it then refreshes
 *   the AVA skills and subagents in every Cursor folder that has them (`ava-mcp update <dir> --yes`).
 * - gctk itself, started by Cursor with `npx -y <GitHub tarball>`: npx never downloads a cached
 *   tarball again, so Cursor keeps the first gctk forever. The update deletes that npx cache folder;
 *   Cursor downloads the newest gctk at its next start.
 * Everything else (Cursor plugins, remote servers, other programs) is updated where it came from.
 */

export type ProgramKind = "uv-github" | "uv-pypi" | "gctk-npx";

export interface Program {
  /** "uv:<tool>" or "gctk". */
  id: string;
  name: string;
  kind: ProgramKind;
  installed?: string;
  latest?: string;
  update: boolean;
  /** The Cursor servers that run it. */
  servers: string[];
  /** Cursor folders whose AVA skills an update refreshes. */
  skills?: string[];
  error?: string;
}

export interface UpdateOptions {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Runs a program (tests pass their own). */
  run?: (command: string, args: string[]) => Promise<{ code: number; output: string }>;
  /** The Cursor folders of the user's projects (default: from the Projects page). */
  projectFolders?: string[];
  /** The ava-mcp that `gctk axl-harness` starts (default: from the Projects page). */
  harnessCommand?: string;
}

interface UvTool {
  name: string;
  dir: string;
  /** The wheel URL it was installed from, if not from PyPI. */
  url?: string;
  /** Paths of its executables. */
  entrypoints: string[];
}

interface Located {
  id: string;
  name: string;
  kind: ProgramKind;
  servers: string[];
  uv?: UvTool;
  npx?: string[];
}

const homeOf = (o: UpdateOptions) => o.home ?? os.homedir();
const envOf = (o: UpdateOptions) => o.env ?? process.env;
const platformOf = (o: UpdateOptions) => o.platform ?? process.platform;
const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "_");
const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Where uv keeps its tools (UV_TOOL_DIR, then the platform defaults). */
function uvToolDirs(o: UpdateOptions): string[] {
  const env = envOf(o);
  const home = homeOf(o);
  const dirs = [env.UV_TOOL_DIR, env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, "uv", "tools") : undefined, path.join(home, ".local", "share", "uv", "tools")];
  if (platformOf(o) === "win32") dirs.push(path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "uv", "data", "tools"));
  return [...new Set(dirs.filter((d): d is string => Boolean(d)))];
}

/** The tool's own requirement and executables, read from uv-receipt.toml. */
function readReceipt(dir: string): UvTool | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, "uv-receipt.toml"), "utf8");
  } catch {
    return undefined;
  }
  const req = /requirements\s*=\s*\[\s*\{([^}]*)\}/.exec(text)?.[1] ?? "";
  const name = /name\s*=\s*"([^"]+)"/.exec(req)?.[1] ?? path.basename(dir);
  const url = /url\s*=\s*"([^"]+)"/.exec(req)?.[1];
  const entrypoints = [...text.matchAll(/install-path\s*=\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\\\/g, "\\"));
  return { name, dir, ...(url ? { url } : {}), entrypoints };
}

function uvTools(o: UpdateOptions): UvTool[] {
  const out: UvTool[] = [];
  for (const root of uvToolDirs(o)) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const n of names) {
      const t = readReceipt(path.join(root, n));
      if (t) out.push(t);
    }
  }
  return out;
}

/** The uv tool a command belongs to: one of its executables, or a file inside its folder. */
function toolOf(command: string, tools: UvTool[]): UvTool | undefined {
  const c = real(command);
  return tools.find((t) => t.entrypoints.some((e) => real(e) === c) || c.startsWith(`${real(t.dir)}${path.sep}`));
}

/** The installed version from the tool's site-packages (<dist>-<version>.dist-info). */
function uvInstalled(t: UvTool): string | undefined {
  const want = normalize(t.name);
  const libs = [path.join(t.dir, "Lib", "site-packages")];
  try {
    for (const py of fs.readdirSync(path.join(t.dir, "lib"))) libs.push(path.join(t.dir, "lib", py, "site-packages"));
  } catch {
    // Windows layout only
  }
  for (const lib of libs) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(lib);
    } catch {
      continue;
    }
    for (const e of entries) {
      const m = /^(.+)-([^-]+)\.dist-info$/.exec(e);
      if (m && normalize(m[1]!) === want) return m[2];
    }
  }
  return undefined;
}

/** npm's cache folder, where npx keeps what it downloaded (`_npx/<hash>`). */
function npmCache(o: UpdateOptions): string {
  const env = envOf(o);
  if (env.npm_config_cache) return env.npm_config_cache;
  if (platformOf(o) === "win32") return path.join(env.LOCALAPPDATA ?? path.join(homeOf(o), "AppData", "Local"), "npm-cache");
  return path.join(homeOf(o), ".npm");
}

const GCTK_SPECS = [GCTK_PACKAGE, /^github:diebergziege\/(gc-toolkit|genesys-cloud-toolkit)(#.*)?$/];
const isGctkSpec = (v: string) => GCTK_SPECS.some((s) => (typeof s === "string" ? s === v : s.test(v)));

/** The npx folders that hold a downloaded gctk, with their versions. */
function gctkNpxFolders(o: UpdateOptions): Array<{ dir: string; version?: string; current: boolean }> {
  const root = path.join(npmCache(o), "_npx");
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: Array<{ dir: string; version?: string; current: boolean }> = [];
  for (const n of names) {
    if (!/^[0-9a-f]{16}$/.test(n)) continue;
    const dir = path.join(root, n);
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
      const specs = Object.values(pkg.dependencies ?? {}).map(String);
      if (!specs.some(isGctkSpec)) continue;
      let version: string | undefined;
      try {
        version = (JSON.parse(fs.readFileSync(path.join(dir, "node_modules", "genesys-cloud-toolkit", "package.json"), "utf8")) as { version?: string }).version;
      } catch {
        version = undefined;
      }
      out.push({ dir, version, current: specs.includes(GCTK_PACKAGE) });
    } catch {
      // not an npx folder
    }
  }
  return out;
}

const isNpx = (cmd: string | undefined) => Boolean(cmd && /^npx(\.cmd|\.exe)?$/i.test(path.basename(cmd)));

/** The programs behind the given servers that gctk can update. */
function locate(servers: ServerInfo[], o: UpdateOptions): Located[] {
  const tools = uvTools(o);
  const found = new Map<string, Located>();
  const add = (l: Omit<Located, "servers">, server: string) => {
    const x = found.get(l.id) ?? { ...l, servers: [] };
    if (!x.servers.includes(server)) x.servers.push(server);
    found.set(l.id, x);
  };
  for (const s of servers) {
    if (s.transport !== "stdio" || !s.command) continue;
    if (isNpx(s.command) && s.args.some(isGctkSpec)) {
      add({ id: "gctk", name: "gctk", kind: "gctk-npx" }, s.name);
      continue;
    }
    // gctk axl-harness starts the AVA harness command, not the node in the entry.
    const command = s.credentials === "axl" ? (o.harnessCommand ?? harnessCommandOf(loadAxlSettings())) : s.command;
    const cmd = path.isAbsolute(command) ? command : which(command, o);
    const t = cmd ? toolOf(cmd, tools) : undefined;
    if (t) add({ id: `uv:${t.name}`, name: t.name, kind: t.url ? "uv-github" : "uv-pypi", uv: t }, s.name);
  }
  return [...found.values()];
}

function which(cmd: string, o: UpdateOptions): string | undefined {
  const exts = platformOf(o) === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const dir of (envOf(o).PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

const RELEASE_WHEEL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\/download\/[^/]+\/[^/]+\.whl$/;

async function getJson(url: string, o: UpdateOptions): Promise<unknown> {
  const res = await (o.fetch ?? fetch)(url, { headers: { Accept: "application/json", "User-Agent": "gctk" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

/** The newest release's wheel of a uv tool installed from GitHub: version and download URL. */
async function latestWheel(t: UvTool, o: UpdateOptions): Promise<{ version: string; url: string }> {
  const m = RELEASE_WHEEL.exec(t.url ?? "");
  if (!m) throw new Error("it was installed from a link gctk cannot check for updates");
  const [, owner, repo] = m;
  const rel = (await getJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, o)) as { assets?: Array<{ name?: string; browser_download_url?: string }> };
  const want = normalize(t.name);
  for (const a of rel.assets ?? []) {
    const w = /^(.+?)-([^-]+)-.+\.whl$/.exec(a.name ?? "");
    const url = a.browser_download_url ?? "";
    // Only a wheel of the same tool from the same repository's releases.
    if (w && normalize(w[1]!) === want && url.startsWith(`https://github.com/${owner}/${repo}/releases/download/`)) return { version: w[2]!, url };
  }
  throw new Error(`the newest release of ${owner}/${repo} has no ${t.name} wheel`);
}

async function latestPypi(name: string, o: UpdateOptions): Promise<string> {
  const r = (await getJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, o)) as { info?: { version?: string } };
  if (!r.info?.version) throw new Error(`PyPI has no version of ${name}`);
  return r.info.version;
}

export const GCTK_LATEST = "https://raw.githubusercontent.com/diebergziege/gc-toolkit/main/package.json";

/** Cursor folders with AVA skills installed by ava-mcp (user level and the projects' folders). */
function avaSkillFolders(o: UpdateOptions): string[] {
  let projects = o.projectFolders;
  if (!projects) {
    try {
      projects = loadAxlSettings().workshops.map((w) => w.folder).filter((f): f is string => Boolean(f));
    } catch {
      projects = [];
    }
  }
  const dirs = [path.join(homeOf(o), ".cursor"), ...projects.map((p) => path.join(p, ".cursor"))];
  return [...new Set(dirs)].filter((d) => fs.existsSync(path.join(d, "skills", "ava-dispatch")));
}

/** What can be updated, with installed and newest versions (asks GitHub, PyPI). */
export async function checkUpdates(servers: ServerInfo[], o: UpdateOptions = {}): Promise<Program[]> {
  return Promise.all(
    locate(servers, o).map(async (l): Promise<Program> => {
      const p: Program = { id: l.id, name: l.name, kind: l.kind, update: false, servers: l.servers };
      try {
        if (l.kind === "gctk-npx") {
          // The download of the link Cursor starts now; older links' downloads only take space.
          const folders = gctkNpxFolders(o);
          p.installed = (folders.find((f) => f.current && f.version) ?? folders.find((f) => f.version))?.version;
          p.latest = ((await getJson(GCTK_LATEST, o)) as { version?: string }).version;
        } else {
          p.installed = uvInstalled(l.uv!);
          p.latest = l.kind === "uv-github" ? (await latestWheel(l.uv!, o)).version : await latestPypi(l.uv!.name, o);
          if (l.uv!.name === "ava-mcp") p.skills = avaSkillFolders(o);
        }
        p.update = Boolean(p.installed && p.latest && olderVersion(p.installed, p.latest));
      } catch (err) {
        p.error = `gctk could not check for a newer version: ${(err as Error).message}.`;
      }
      return p;
    }),
  );
}

const NPX_NEXT = "Quit Cursor and open it again: it then downloads the newest gctk, and the next time the AI opens this UI it runs the new version.";

/** Deletes the gctk downloads npx keeps (it never downloads a cached tarball again); returns the version they had. */
function dropGctkNpx(o: UpdateOptions): string | undefined {
  const folders = gctkNpxFolders(o);
  const from = (folders.find((f) => f.current && f.version) ?? folders.find((f) => f.version))?.version;
  for (const f of folders) fs.rmSync(f.dir, { recursive: true, force: true });
  return from;
}

// ------------------------------------------------------- gctk itself (top bar)

/** How the gctk that runs this UI was installed, which decides how it is updated. */
export type GctkInstall = "npx" | "claude-plugin" | "cursor-plugin" | "editor-copy" | "dev" | "other";

export interface GctkVersion {
  running: string;
  latest?: string;
  update: boolean;
  install: GctkInstall;
  error?: string;
}

export function gctkInstall(js: string | undefined = runningGctkJs(), home = os.homedir()): GctkInstall {
  if (!js) return "dev";
  const p = path.resolve(js);
  const under = (...parts: string[]) => p.startsWith(`${path.join(home, ...parts)}${path.sep}`);
  if (p.split(path.sep).includes("_npx")) return "npx";
  if (under(".claude", "plugins")) return "claude-plugin";
  if (under(".cursor", "plugins")) return "cursor-plugin";
  if (p === path.resolve(stableGctkJs())) return "editor-copy";
  return "other";
}

/** Is a newer gctk on GitHub than the one running this UI? A development run never asks. */
export async function checkGctk(running: string, o: UpdateOptions & { js?: string } = {}): Promise<GctkVersion> {
  const install = gctkInstall("js" in o ? o.js : runningGctkJs(), homeOf(o));
  if (install === "dev" || !/^\d+\.\d+\.\d+/.test(running)) return { running, update: false, install };
  try {
    const latest = ((await getJson(GCTK_LATEST, o)) as { version?: string }).version;
    return { running, latest, update: Boolean(latest && olderVersion(running, latest)), install };
  } catch (err) {
    return { running, update: false, install, error: (err as Error).message };
  }
}

/** The update a click can do: gctk from npx (Cursor without the plugin). Plugins update in their editor. */
export function updateGctk(install: GctkInstall, o: UpdateOptions = {}): { from?: string; next: string } {
  if (install !== "npx") throw new GctkError("INVALID_INPUT", "This gctk is updated in the editor it came with; the page says how.");
  return { from: dropGctkNpx(o), next: NPX_NEXT };
}

function runProgram(command: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const keep = (b: Buffer) => (output = (output + b.toString()).slice(-4000));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill(), 5 * 60_000);
    child.on("error", (err) => (clearTimeout(timer), resolve({ code: -1, output: err.message })));
    child.on("close", (code) => (clearTimeout(timer), resolve({ code: code ?? -1, output })));
  });
}

/** uv itself: on PATH, or where its installers put it (Cursor may start gctk with a short PATH). */
function findUv(o: UpdateOptions): string | undefined {
  const home = homeOf(o);
  const exe = platformOf(o) === "win32" ? "uv.exe" : "uv";
  const onPath = which("uv", o);
  if (onPath) return onPath;
  return [path.join(home, ".local", "bin", exe), path.join(home, ".cargo", "bin", exe), "/opt/homebrew/bin/uv", "/usr/local/bin/uv"].find((p) => fs.existsSync(p));
}

const lastLines = (s: string) => s.trim().split(/\r?\n/).slice(-6).join("\n");

export interface UpdateResult {
  program: string;
  from?: string;
  to?: string;
  /** Cursor folders whose AVA skills were refreshed. */
  skills: string[];
  /** Folders whose skills could not be refreshed, with why. */
  skillErrors: string[];
  /** What the user does next. */
  next: string;
}

/** Updates one program (a click on the Cursor setup page). */
export async function updateProgram(id: string, servers: ServerInfo[], o: UpdateOptions = {}): Promise<UpdateResult> {
  const l = locate(servers, o).find((x) => x.id === id);
  if (!l) throw new GctkError("INVALID_INPUT", "gctk does not know how to update this program (any more); refresh the page.");
  const run = o.run ?? runProgram;
  if (l.kind === "gctk-npx") return { program: "gctk", from: dropGctkNpx(o), skills: [], skillErrors: [], next: NPX_NEXT };
  const t = l.uv!;
  const from = uvInstalled(t);
  const uv = findUv(o);
  if (!uv) throw new GctkError("INVALID_INPUT", `gctk could not find uv, which installed ${t.name}. Install uv (docs.astral.sh/uv) and try again.`);
  let r: { code: number; output: string };
  if (l.kind === "uv-github") {
    const w = await latestWheel(t, o);
    r = await run(uv, ["tool", "install", "--force", w.url, "--reinstall-package", t.name]);
  } else r = await run(uv, ["tool", "upgrade", t.name]);
  if (r.code !== 0) throw new GctkError("UPDATE_FAILED", `uv could not update ${t.name}:\n${lastLines(r.output)}`);
  const to = uvInstalled(t);
  const skills: string[] = [];
  const skillErrors: string[] = [];
  if (t.name === "ava-mcp") {
    const exe = t.entrypoints.find((e) => /ava-mcp(\.exe)?$/i.test(e) && fs.existsSync(e));
    for (const dir of avaSkillFolders(o)) {
      if (!exe) {
        skillErrors.push(`${dir}: ava-mcp not found`);
        continue;
      }
      // ava-mcp refuses to replace skills that are links (it deletes before it installs).
      if (fs.lstatSync(path.join(dir, "skills", "ava-dispatch")).isSymbolicLink()) {
        skillErrors.push(`${dir}: its AVA skills are links to another folder; update them there`);
        continue;
      }
      const s = await run(exe, ["update", dir, "--yes"]);
      if (s.code === 0) skills.push(dir);
      else skillErrors.push(`${dir}: ${lastLines(s.output)}`);
    }
  }
  return { program: t.name, from, to, skills, skillErrors, next: "Restart the server so it runs the new version: in Cursor Settings → MCP, switch it off and on; quit and reopen the Claude app." };
}
