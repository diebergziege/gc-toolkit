import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readSecret, writeSecret } from "../core/credentials.js";
import { appGctkJs, appVersion } from "../core/install.js";
import { olderVersion } from "../core/stable-gctk.js";
import { gctkHome } from "../core/paths.js";
import { getUiPort, setUiPort } from "../core/profiles.js";
import { DEFAULT_UI_PORT, startUi, uiUrl } from "./server.js";

declare const __GCTK_VERSION__: string;
declare const __GCTK_BUILD_ID__: string;
const VERSION = typeof __GCTK_VERSION__ === "string" ? __GCTK_VERSION__ : "dev";
const BUILD_ID = typeof __GCTK_BUILD_ID__ === "string" ? __GCTK_BUILD_ID__ : "dev";
const UI_BUILD = `${VERSION}+${BUILD_ID}`;

/**
 * One shared UI per user: a detached background process that outlives agent sessions.
 * ui.json (no secrets) says where it runs; the session token lives in the OS keychain,
 * so the agent cannot read it with file or search tools.
 *
 * Its address stays the same, so users can bookmark it: the port is kept in config.yaml (4285 at
 * first; when another program has it, the next free one, which is then kept), and the token is
 * reused from the keychain at every start, so the browser that once opened the UI still has it.
 */
export interface UiInfo {
  pid: number;
  port: number;
  /** Toolkit version + git build id (see ensureSharedUi). */
  version: string;
  startedAt: string;
}

/** One token per gctk home, so separate setups (tests, other homes) never mix up their UIs. */
const tokenAccount = () => `__ui-token__${crypto.createHash("sha256").update(gctkHome()).digest("hex").slice(0, 12)}`;
const infoFile = () => path.join(gctkHome(), "ui.json");
const tokenFile = () => path.join(gctkHome(), "ui.token"); // fallback where no keychain exists
const IDLE_MS = 12 * 60 * 60 * 1000;

function saveToken(token: string): void {
  try {
    writeSecret(tokenAccount(), token);
  } catch {
    fs.writeFileSync(tokenFile(), token, { mode: 0o600 });
  }
}

function readToken(): string | undefined {
  try {
    const t = readSecret(tokenAccount());
    if (t) return t;
  } catch {
    // no keychain on this platform
  }
  return fs.existsSync(tokenFile()) ? fs.readFileSync(tokenFile(), "utf8").trim() : undefined;
}

function readInfo(): UiInfo | undefined {
  try {
    return JSON.parse(fs.readFileSync(infoFile(), "utf8")) as UiInfo;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** URL (with token) of the running shared UI, if it answers. */
export async function findRunningUi(): Promise<{ url: string; info: UiInfo } | undefined> {
  const info = readInfo();
  const token = readToken();
  if (!info || !token || !alive(info.pid)) return undefined;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/overview`, { headers: { "x-gctk-token": token }, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return undefined;
  } catch {
    return undefined;
  }
  return { url: uiUrl(info.port, token), info };
}

export function stopRunningUi(): boolean {
  const info = readInfo();
  fs.rmSync(infoFile(), { force: true });
  if (info && alive(info.pid)) {
    process.kill(info.pid, "SIGTERM");
    return true;
  }
  return false;
}

/** Runs the shared UI in this process until stopped or idle for 12 hours. */
export async function runUiDaemon(opts: { port?: number } = {}): Promise<void> {
  process.env.GCTK_UI_DAEMON = "1";
  const token = readToken() || crypto.randomBytes(24).toString("base64url");
  let last = Date.now();
  const startedAt = new Date().toISOString();
  const writeInfo = (port: number) => {
    fs.mkdirSync(gctkHome(), { recursive: true });
    fs.writeFileSync(infoFile(), JSON.stringify({ pid: process.pid, port, version: UI_BUILD, startedAt } satisfies UiInfo), { mode: 0o600 });
  };
  const ui = await startUi({
    preferPort: opts.port ?? getUiPort() ?? DEFAULT_UI_PORT,
    token,
    onActivity: () => (last = Date.now()),
    onShutdown: () => stop(),
    onPortChange: (port) => {
      setUiPort(port);
      writeInfo(port);
    },
  });
  saveToken(token);
  // The port it got is the one it keeps (also when the wanted one was taken).
  setUiPort(ui.port);
  writeInfo(ui.port);
  const timer = setInterval(() => {
    if (Date.now() - last > IDLE_MS) stop();
  }, 60_000);
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    const info = readInfo();
    if (info?.pid === process.pid) fs.rmSync(infoFile(), { force: true });
    void ui.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

/**
 * What `build` (version+build id) does about the shared UI: reuse the running one, or start one from
 * itself or from the installed copy (app/, version `installed`). A development run (version "dev")
 * always runs itself.
 */
export function uiPlan(o: { build: string; running?: Pick<UiInfo, "version" | "port">; keptPort?: number; installed?: string; restart?: boolean }): "reuse" | "start-self" | "start-installed" {
  const version = o.build.split("+")[0]!;
  const released = /^\d+\.\d+\.\d+/.test(version);
  if (o.running && !o.restart && o.running.port === (o.keptPort ?? o.running.port)) {
    // Same build on the kept port: reuse it. On another port (gctk ui --port): start it again there.
    if (o.running.version === o.build || (released && olderVersion(version, o.running.version.split("+")[0]!))) return "reuse";
  }
  return released && o.installed && olderVersion(version, o.installed) ? "start-installed" : "start-self";
}

/**
 * Returns the URL of the shared UI, starting it as a detached background process when needed.
 * A UI from another build is replaced, never by an older version: an editor's plugin that has not
 * updated yet reuses the newer UI the top bar installed, and starts the installed copy (app/) when
 * that one is newer than itself. `restart` replaces the running UI in any case.
 */
export async function ensureSharedUi(opts: { restart?: boolean } = {}): Promise<string> {
  const running = await findRunningUi();
  const plan = uiPlan({ build: UI_BUILD, running: running?.info, keptPort: getUiPort(), installed: appVersion(), restart: opts.restart });
  if (plan === "reuse") return running!.url;
  if (running) stopRunningUi();
  const script = plan === "start-installed" ? appGctkJs() : process.argv[1]!;
  const child = spawn(process.execPath, [...(plan === "start-self" ? process.execArgv : []), script, "ui", "--daemon"], { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const started = await findRunningUi();
    if (started) return started.url;
  }
  throw new Error("The gctk UI did not start. Run `gctk ui` in a terminal to see why.");
}
