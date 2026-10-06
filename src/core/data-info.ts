import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keychainName, readSecret, hasStoredCredentials } from "./credentials.js";
import { gctkHome } from "./paths.js";
import { listProfiles, loadProfile } from "./profiles.js";

/**
 * Where gctk keeps the user's data (UI page "Your data"): every file and folder in the gctk home with
 * what it holds, the keychain entries by name (never their values), and what gctk wrote elsewhere.
 */

export interface DataPlace {
  key: string;
  label: string;
  what: string;
  path: string;
  exists: boolean;
  bytes: number;
  items?: number;
}

export interface KeychainEntry {
  account: string;
  what: string;
  stored: boolean;
}

export interface DataInfo {
  home: string;
  /** The user's home folder, shown as ~ on the page. */
  userHome: string;
  /** GCTK_HOME moves the whole folder. */
  homeFromEnv: boolean;
  keychain: string;
  places: DataPlace[];
  secrets: KeychainEntry[];
  elsewhere: DataPlace[];
}

function size(p: string): { bytes: number; items?: number } {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return { bytes: st.size };
    let bytes = 0;
    const entries = fs.readdirSync(p);
    for (const e of entries) bytes += size(path.join(p, e)).bytes;
    return { bytes, items: entries.length };
  } catch {
    return { bytes: 0 };
  }
}

const HOME_PLACES: Array<[string, string, string]> = [
  ["profiles", "Orgs", "One file per org: name, region and tier. No secrets; those are in the keychain."],
  ["config.yaml", "The org you work on", "Which org the AI and the pages use by default."],
  ["mcp-launch.json", "AI setup: servers started through gctk", "For every MCP server whose secret you moved to the keychain: its command and variables (signed)."],
  ["ai-setup.json", "AI setup: added locations", "Config files and project folders you added on the AI setup page."],
  ["removed-skills", "AI setup: removed skills", "Skills you removed on the AI setup page, kept so Restore can put them back."],
  ["demos", "Demos: deployments and logs", "Per org what a deploy created (for Remove), the commands that run, and their logs."],
  ["demo-sources.json", "Demos: snapshot sources", "Only for whoever maintains a demo: the org its snapshot is read from, and the texts replaced in it."],
  ["demo-ready", "Demo ready: what the page did", "Every change Demo ready made in an org, so Clean up removes exactly that."],
  ["axl.json", "AXL workshops", "Your workshops with their org and folder."],
  ["harness-starts.json", "AXL: harness starts", "When Cursor last started a workshop's AVA harness."],
  ["bin", "gctk for your editors", "A copy of gctk that the entries gctk writes into editor configs start, so plugin updates do not break them."],
  ["cache", "Cache", "Website logos and staged schedule uploads; safe to delete."],
  ["ui.json", "The running UI", "Port and process of the background UI (no token; that is in the keychain)."],
];

/** Same name as in ui/daemon.ts: one token per gctk home. */
const tokenAccount = (home: string) => `__ui-token__${crypto.createHash("sha256").update(home).digest("hex").slice(0, 12)}`;

function has(account: string): boolean {
  try {
    return Boolean(readSecret(account));
  } catch {
    return false;
  }
}

export function dataInfo(opts: { has?: (account: string) => boolean } = {}): DataInfo {
  const stored = opts.has ?? has;
  const home = gctkHome();
  const places: DataPlace[] = HOME_PLACES.map(([rel, label, what]) => {
    const p = path.join(home, rel);
    return { key: rel, label, what, path: p, exists: fs.existsSync(p), ...size(p) };
  });

  const secrets: KeychainEntry[] = [];
  for (const name of listProfiles()) {
    try {
      const p = loadProfile(name);
      if (p.credentials === "keychain") secrets.push({ account: name, what: `Client ID and secret of the org "${name}"`, stored: hasStoredCredentials(p) });
    } catch {
      // unreadable profile
    }
  }
  let launches: Array<{ account: string; server: string; file: string }> = [];
  try {
    launches = Object.values((JSON.parse(fs.readFileSync(path.join(home, "mcp-launch.json"), "utf8")) as { records?: Record<string, { account: string; server: string; file: string }> }).records ?? {});
  } catch {
    launches = [];
  }
  for (const account of [...new Set(launches.map((l) => l.account))]) {
    const users = launches.filter((l) => l.account === account);
    const names = [...new Set(users.map((u) => u.server))];
    secrets.push({ account, what: `Secret of ${names.join(", ")} (AI setup, ${users.length} entr${users.length > 1 ? "ies" : "y"} in editor configs)`, stored: stored(account) });
  }
  secrets.push({ account: "__approval-key__", what: "Key that signs the AI setup launch records", stored: stored("__approval-key__") });
  secrets.push({ account: tokenAccount(home), what: "Session token of the local UI", stored: stored(tokenAccount(home)) });

  // Written outside the gctk folder: the config files AI setup rewrote.
  const elsewhere: DataPlace[] = [];
  for (const file of [...new Set(launches.map((l) => l.file))]) {
    elsewhere.push({ key: `config:${file}`, label: "Editor config changed by AI setup", what: "Entries here start through gctk (secret in the keychain)", path: file, exists: fs.existsSync(file), ...size(file) });
  }
  let keychain = "no keychain on this system";
  try {
    keychain = keychainName();
  } catch {
    // unsupported platform
  }
  return { home, userHome: os.homedir(), homeFromEnv: Boolean(process.env.GCTK_HOME), keychain, places, secrets, elsewhere };
}

/** Only places the page lists may be opened. */
export function dataPath(key: string, opts: { has?: (account: string) => boolean } = {}): string | undefined {
  const info = dataInfo(opts);
  if (key === "home") return info.home;
  return [...info.places, ...info.elsewhere].find((p) => p.key === key && p.exists)?.path;
}
