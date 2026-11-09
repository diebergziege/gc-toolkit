import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { GCTK_PACKAGE } from "./ai-setup.js";
import { GctkError } from "./errors.js";
import { claudeAppConfigFile, gctkHome } from "./paths.js";
import { olderVersion } from "./stable-gctk.js";

/**
 * gctk for people without Cursor (decision 2026-11-05): `gctk install`, run once through npx, puts
 * gctk and its demos into the gctk home (app/, the same layout as the repository, so the demos are
 * found next to dist/), a `gctk` command on the PATH, an app to click (macOS ~/Applications/gctk.app,
 * Windows Start menu and Desktop shortcuts, Linux menu entry) and, where the Claude app is installed,
 * the gctk MCP server in its config. install.json in the gctk home lists everything written outside
 * the gctk home, so `gctk uninstall` removes exactly that. The top bar updates app/ from GitHub.
 * The Partner edition (decision 2026-11-09, for partner managers) is the same install with an app
 * "gctk Partner" whose UI shows only the Partner page, and no Claude app entry.
 */

export const EDITIONS = ["full", "partner"] as const;
export type Edition = (typeof EDITIONS)[number];

export const appDir = () => path.join(gctkHome(), "app");
export const appGctkJs = () => path.join(appDir(), "dist", "gctk.js");
/** The Node.js the downloadable installers bring along (installer/), used when no other one is there. */
export const privateNodeDir = () => path.join(gctkHome(), "node");
const recordFile = () => path.join(gctkHome(), "install.json");

export interface InstallRecord {
  version: string;
  node: string;
  installedAt: string;
  /** Missing in records before 0.39: full. */
  edition?: Edition;
  /** Files gctk wrote outside the gctk home (command, launchers). */
  files: string[];
  /** The shell startup file that got gctk's command folder on the PATH. */
  rc?: { file: string; line: string };
  /** Windows: the folder added to the user's PATH. */
  winPath?: string;
  /** The Claude app config that got the gctk server. */
  claudeApp?: string;
}

export interface InstallOptions {
  /** gctk.js to copy (default: the one running). */
  from: string;
  version: string;
  /** The demos folder that ships with it. */
  demos?: string;
  node?: string;
  edition?: Edition;
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  claudeApp?: boolean;
  /** Runs PowerShell on Windows (tests pass their own). */
  run?: (command: string, args: string[]) => { code: number; output: string };
}

export interface InstallResult {
  app: string;
  command: string;
  launcher?: string;
  rc?: string;
  /** ours: gctk install had added it before (refreshed); kept: an entry of the user's own. */
  claudeApp: "added" | "ours" | "kept" | "not-installed" | "skipped";
  notes: string[];
}

export function loadInstallRecord(): InstallRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(recordFile(), "utf8")) as InstallRecord;
  } catch {
    return undefined;
  }
}

/** Partner only when the running gctk is the installed copy of the Partner edition; Cursor's or the plugin's gctk is always full. */
export function runningEdition(js: string | undefined): Edition {
  if (!js) return "full";
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(js) === real(appGctkJs()) && loadInstallRecord()?.edition === "partner" ? "partner" : "full";
}

/** What the app to click is called, and the page it opens. */
const launcherOf = (edition: Edition) =>
  edition === "partner"
    ? { name: "gctk Partner", file: "gctk-partner", display: "gctk Partner · Enablement Radar", id: "com.github.diebergziege.gctk.partner", args: "ui partner" }
    : { name: "gctk", file: "gctk", display: "gctk · Genesys Cloud Toolkit", id: "com.github.diebergziege.gctk", args: "ui" };

/** Puts gctk.js, the demos and a package.json (ES module) into app/, replacing the folder whole. */
function writeApp(files: { js: Buffer; version: string; demos?: Array<[string, Buffer]> | string }): void {
  const dir = appDir();
  const tmp = `${dir}.new-${process.pid}`;
  const old = `${dir}.old-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, "dist"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "dist", "gctk.js"), files.js, { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, "package.json"), `${JSON.stringify({ name: "genesys-cloud-toolkit", version: files.version, type: "module", private: true, description: "gctk, installed by gctk install" }, null, 2)}\n`);
  if (typeof files.demos === "string") fs.cpSync(files.demos, path.join(tmp, "demos"), { recursive: true });
  else for (const [rel, data] of files.demos ?? []) {
    const file = path.join(tmp, "demos", rel);
    if (!file.startsWith(path.join(tmp, "demos") + path.sep)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
  if (fs.existsSync(dir)) fs.renameSync(dir, old);
  fs.renameSync(tmp, dir);
  fs.rmSync(old, { recursive: true, force: true });
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A shell script that runs gctk with this node, or another one when that one is gone (nvm, upgrade). */
function shScript(node: string, js: string, args: string, env: NodeJS.ProcessEnv): string {
  return [
    "#!/bin/sh",
    "# Written by gctk install; gctk uninstall removes it.",
    ...(env.GCTK_HOME ? [`export GCTK_HOME=${shQuote(env.GCTK_HOME)}`] : []),
    `NODE=${shQuote(node)}`,
    '[ -x "$NODE" ] || NODE="$(command -v node || true)"',
    '[ -x "$NODE" ] || for n in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do [ -x "$n" ] && NODE="$n" && break; done',
    `exec "$NODE" ${shQuote(js)} ${args}`,
    "",
  ].join("\n");
}

const write = (file: string, text: string, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
};

/** The shell startup file that sets the PATH for new terminals. */
function rcFile(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  const shell = path.basename(env.SHELL ?? (platform === "darwin" ? "zsh" : "bash"));
  if (shell === "zsh") return path.join(home, ".zshrc");
  if (shell === "bash") return path.join(home, platform === "darwin" ? ".bash_profile" : ".bashrc");
  return path.join(home, ".profile");
}

/** Adds the Claude app's gctk server (gc_ui and friends); one the user set up is kept as it is. */
function addToClaudeApp(node: string, js: string): "added" | "ours" | "kept" | "not-installed" {
  const file = claudeAppConfigFile();
  if (!fs.existsSync(path.dirname(file))) return "not-installed";
  let cfg: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  let mode = 0o600;
  let indent: string | number = 2;
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    try {
      cfg = JSON.parse(text);
    } catch {
      throw new GctkError("INVALID_INPUT", `${file} is not valid JSON; fix it first, or install with --no-claude-app.`);
    }
    mode = fs.statSync(file).mode & 0o777;
    indent = /^\{\s*\n(\t)/.test(text) ? "\t" : (/^\{\s*\n( +)/.exec(text)?.[1]?.length ?? 2);
  }
  const old = cfg.mcpServers?.gctk as { args?: unknown[] } | undefined;
  if (old && old.args?.[0] !== js) return "kept";
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), gctk: { command: node, args: [js, "mcp"] } };
  const tmp = `${file}.gctk-${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, indent)}\n`, { mode });
  fs.renameSync(tmp, file);
  return old ? "ours" : "added";
}

function runPowerShell(command: string, args: string[]): { code: number; output: string } {
  const r = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  return { code: r.status ?? -1, output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? r.error.message : ""}` };
}

/** Installs gctk for use without an editor. Running it again updates and repairs everything. */
export function installGctk(o: InstallOptions): InstallResult {
  const home = o.home ?? os.homedir();
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const node = o.node ?? process.execPath;
  const edition = o.edition ?? "full";
  const launch = launcherOf(edition);
  const previous = loadInstallRecord();
  const files: string[] = [];
  const notes: string[] = [];
  // npx keeps the first download of a link, so a later install may run an older gctk than the updated app/.
  let have: string | undefined;
  try {
    have = (JSON.parse(fs.readFileSync(path.join(appDir(), "package.json"), "utf8")) as { version?: string }).version;
  } catch {
    have = undefined;
  }
  const keep = have && fs.existsSync(appGctkJs()) && olderVersion(o.version, have);
  if (keep) notes.push(`Kept the installed gctk ${have}, which is newer than this one (${o.version}).`);
  else if (path.resolve(o.from) !== path.resolve(appGctkJs())) writeApp({ js: fs.readFileSync(o.from), version: o.version, demos: o.demos });
  const js = appGctkJs();
  const result: InstallResult = { app: appDir(), command: "", claudeApp: "skipped", notes };
  const record: InstallRecord = { version: keep ? have! : o.version, node, installedAt: new Date().toISOString(), edition, files };

  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    const bin = path.join(local, "gctk", "bin");
    const cmd = path.join(bin, "gctk.cmd");
    write(cmd, `@echo off\r\nrem Written by gctk install; gctk uninstall removes it.\r\n${env.GCTK_HOME ? `set "GCTK_HOME=${env.GCTK_HOME}"\r\n` : ""}"${node}" "${js}" %*\r\n`);
    files.push(cmd);
    result.command = cmd;
    const roaming = env.APPDATA ?? path.join(home, "AppData", "Roaming");
    const links = [path.join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", `${launch.name}.lnk`), path.join(env.USERPROFILE ?? home, "Desktop", `${launch.name}.lnk`)];
    const script = [
      `$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not $p) { $p = '' }`,
      `if (($p -split ';') -notcontains ${psQuote(bin)}) { [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + ${psQuote(bin)}).TrimStart(';'), 'User') }`,
      `$w = New-Object -ComObject WScript.Shell`,
      ...links.map((l) => `if (Test-Path ${psQuote(path.dirname(l))}) { $s = $w.CreateShortcut(${psQuote(l)}); $s.TargetPath = ${psQuote(node)}; $s.Arguments = ${psQuote(`"${js}" ${launch.args}`)}; $s.WindowStyle = 7; $s.Description = ${psQuote(launch.display)}; $s.Save() }`),
    ].join("; ");
    const r = (o.run ?? runPowerShell)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
    if (r.code !== 0) notes.push(`Windows did not take the shortcuts and the PATH entry (${r.output.trim().split(/\r?\n/).pop()}). Start gctk with ${cmd} ${launch.args} instead.`);
    else {
      files.push(...links);
      record.winPath = bin;
      result.launcher = links[0];
      notes.push(`Open a new terminal for the gctk command; the Start menu and the Desktop have ${launch.name} now.`);
    }
  } else {
    const bin = path.join(home, ".local", "bin");
    const cmd = path.join(bin, "gctk");
    write(cmd, shScript(node, js, '"$@"', env), 0o755);
    files.push(cmd);
    result.command = cmd;
    if (!(env.PATH ?? "").split(path.delimiter).includes(bin)) {
      const rc = rcFile(home, platform, env);
      const line = 'export PATH="$HOME/.local/bin:$PATH" # gctk';
      const text = fs.existsSync(rc) ? fs.readFileSync(rc, "utf8") : "";
      if (!text.includes(line)) fs.writeFileSync(rc, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`);
      record.rc = { file: rc, line };
      result.rc = rc;
      notes.push(`Added ${bin} to the PATH in ${rc}; open a new terminal for the gctk command.`);
    }
    if (platform === "darwin") {
      const appBundle = path.join(home, "Applications", `${launch.name}.app`);
      fs.rmSync(appBundle, { recursive: true, force: true });
      write(path.join(appBundle, "Contents", "MacOS", "gctk"), shScript(node, js, launch.args, env), 0o755);
      write(path.join(appBundle, "Contents", "Info.plist"), [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0"><dict>',
        `<key>CFBundleName</key><string>${launch.name}</string>`,
        `<key>CFBundleDisplayName</key><string>${launch.display}</string>`,
        `<key>CFBundleIdentifier</key><string>${launch.id}</string>`,
        "<key>CFBundleExecutable</key><string>gctk</string>",
        "<key>CFBundlePackageType</key><string>APPL</string>",
        `<key>CFBundleShortVersionString</key><string>${o.version}</string>`,
        "<key>LSUIElement</key><true/>",
        "</dict></plist>",
        "",
      ].join("\n"));
      files.push(appBundle);
      result.launcher = appBundle;
      notes.push(`Open ${launch.name} from Spotlight or Launchpad (in your Applications folder); drag it to the Dock to keep it there.`);
    } else {
      const desktop = path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "applications", `${launch.file}.desktop`);
      const q = (s: string) => `"${s.replace(/(["\\`$])/g, "\\$1")}"`;
      write(desktop, `[Desktop Entry]\nType=Application\nName=${launch.name}\nComment=${launch.display}\nExec=${env.GCTK_HOME ? `env GCTK_HOME=${q(env.GCTK_HOME)} ` : ""}${q(node)} ${q(js)} ${launch.args}\nTerminal=false\nCategories=Development;\n`);
      files.push(desktop);
      result.launcher = desktop;
      notes.push(`${launch.name} is in your applications menu now.`);
    }
  }
  // Switching the edition: the other edition's app goes.
  for (const f of previous?.files ?? []) if (!files.includes(f)) fs.rmSync(f, { recursive: true, force: true });

  if (o.claudeApp !== false && edition === "full") {
    result.claudeApp = addToClaudeApp(node, js);
    if (result.claudeApp === "added" || result.claudeApp === "ours") record.claudeApp = claudeAppConfigFile();
    if (result.claudeApp === "added") {
      notes.push('Added gctk to the Claude app: quit and reopen it, then ask "Open the gctk UI."');
    }
  } else if (previous?.claudeApp) removeFromClaudeApp(previous.claudeApp);
  fs.mkdirSync(gctkHome(), { recursive: true });
  fs.writeFileSync(recordFile(), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return result;
}

/** Removes what gctk install wrote; the orgs, keychain entries and everything else in the gctk home stay. */
export function uninstallGctk(o: Pick<InstallOptions, "run"> = {}): string[] {
  const r = loadInstallRecord();
  const removed: string[] = [];
  for (const f of r?.files ?? []) {
    if (!fs.existsSync(f)) continue;
    fs.rmSync(f, { recursive: true, force: true });
    removed.push(f);
  }
  if (r?.rc && fs.existsSync(r.rc.file)) {
    const text = fs.readFileSync(r.rc.file, "utf8");
    const next = text.split("\n").filter((l) => l !== r.rc!.line).join("\n");
    if (next !== text) (fs.writeFileSync(r.rc.file, next), removed.push(`the PATH line in ${r.rc.file}`));
  }
  if (r?.winPath) {
    const script = `$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($p) { [Environment]::SetEnvironmentVariable('Path', (($p -split ';') | Where-Object { $_ -and $_ -ne ${psQuote(r.winPath)} }) -join ';', 'User') }`;
    (o.run ?? runPowerShell)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
    removed.push(`${r.winPath} from the PATH`);
  }
  if (r?.claudeApp && removeFromClaudeApp(r.claudeApp)) removed.push(`gctk in ${r.claudeApp}`);
  if (fs.existsSync(appDir())) (fs.rmSync(appDir(), { recursive: true, force: true }), removed.push(appDir()));
  try {
    if (fs.existsSync(privateNodeDir())) (fs.rmSync(privateNodeDir(), { recursive: true, force: true }), removed.push(privateNodeDir()));
  } catch {
    // Windows keeps the running node.exe locked; the installer replaces it next time
  }
  fs.rmSync(recordFile(), { force: true });
  return removed;
}

/** Removes the gctk entry that gctk install wrote into the Claude app; one of the user's own stays. */
function removeFromClaudeApp(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, { args?: string[] }> };
    if (cfg.mcpServers?.gctk?.args?.[0] !== appGctkJs()) return false;
    delete cfg.mcpServers.gctk;
    fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
    return true;
  } catch {
    // not JSON any more: leave it to the user
    return false;
  }
}

// ------------------------------------------------------------------ update

/** Files of a tar archive (GitHub's tarballs: ustar with pax headers). */
export function untar(buf: Buffer): Array<[string, Buffer]> {
  const out: Array<[string, Buffer]> = [];
  let off = 0;
  let longName: string | undefined;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (at: number, len: number) => h.subarray(at, at + len).toString("utf8").replace(/\0[\s\S]*$/, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = h[156] ? String.fromCharCode(h[156]) : "0";
    const prefix = h.subarray(257, 263).toString("latin1").startsWith("ustar") ? field(345, 155) : "";
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"))?.[1];
      continue;
    }
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0[\s\S]*$/, "");
      continue;
    }
    longName = undefined;
    if (type === "0" || type === "7") out.push([name, Buffer.from(data)]);
  }
  return out;
}

/** gctk.js, version and demos from GitHub's tarball of gctk (the archive's top folder is dropped). */
export function readGctkTarball(tgz: Buffer): { js: Buffer; version: string; demos: Array<[string, Buffer]> } {
  let files: Array<[string, Buffer]>;
  try {
    files = untar(zlib.gunzipSync(tgz));
  } catch {
    throw new GctkError("UPDATE_FAILED", "GitHub's download of gctk could not be unpacked.");
  }
  const rel = files.map(([n, d]) => [n.split("/").slice(1).join("/"), d] as [string, Buffer]).filter(([n]) => n && !n.split("/").includes(".."));
  const js = rel.find(([n]) => n === "dist/gctk.js")?.[1];
  const pkg = rel.find(([n]) => n === "package.json")?.[1];
  let version: string | undefined;
  try {
    version = (JSON.parse(pkg?.toString("utf8") ?? "") as { version?: string }).version;
  } catch {
    version = undefined;
  }
  if (!js || !js.subarray(0, 20).toString("utf8").startsWith("#!/usr/bin/env node") || !version) throw new GctkError("UPDATE_FAILED", "GitHub's download holds no gctk.");
  return { js, version, demos: rel.filter(([n]) => n.startsWith("demos/")).map(([n, d]) => [n.slice("demos/".length), d]) };
}

/** Replaces app/ with the newest gctk from GitHub. */
export async function updateInstalledGctk(o: { fetch?: typeof fetch; url?: string } = {}): Promise<{ from?: string; to: string }> {
  const res = await (o.fetch ?? fetch)(o.url ?? GCTK_PACKAGE, { headers: { "User-Agent": "gctk" }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new GctkError("UPDATE_FAILED", `GitHub answered ${res.status}; try again later.`);
  const next = readGctkTarball(Buffer.from(await res.arrayBuffer()));
  const record = loadInstallRecord();
  writeApp(next);
  if (record) fs.writeFileSync(recordFile(), `${JSON.stringify({ ...record, version: next.version }, null, 2)}\n`, { mode: 0o600 });
  return { from: record?.version, to: next.version };
}
