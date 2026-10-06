import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readSecret, writeSecret } from "../core/credentials.js";
import { gctkHome } from "../core/paths.js";
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
  const token = crypto.randomBytes(24).toString("base64url");
  let last = Date.now();
  const ui = await startUi({ port: opts.port, preferPort: DEFAULT_UI_PORT, token, onActivity: () => (last = Date.now()), onShutdown: () => stop() });
  saveToken(token);
  fs.mkdirSync(gctkHome(), { recursive: true });
  fs.writeFileSync(infoFile(), JSON.stringify({ pid: process.pid, port: ui.port, version: UI_BUILD, startedAt: new Date().toISOString() } satisfies UiInfo), { mode: 0o600 });
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
 * Returns the URL of the shared UI, starting it as a detached background process when needed.
 * A UI from an older toolkit version is replaced.
 */
export async function ensureSharedUi(): Promise<string> {
  const running = await findRunningUi();
  if (running && running.info.version === UI_BUILD) return running.url;
  if (running) stopRunningUi();
  const script = process.argv[1]!;
  const child = spawn(process.execPath, [...process.execArgv, script, "ui", "--daemon"], { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const started = await findRunningUi();
    if (started) return started.url;
  }
  throw new Error("The gctk UI did not start. Run `gctk ui` in a terminal to see why.");
}
