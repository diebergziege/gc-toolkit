import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { GctkError } from "./errors.js";
import { untar } from "./install.js";
import { gctkHome } from "./paths.js";

/**
 * MCP servers from a GitHub repository (AI Coding Tools, Add MCP server → From GitHub, decision
 * 2026-11-04): gctk downloads the repository (no git needed) into mcp-servers/<owner>__<repo> in the
 * gctk home and reads the MCP config it ships: a Claude Code or Cursor plugin manifest
 * (`.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, with `userConfig`) or a plain
 * `.mcp.json` / `mcp.json`. Plugin-folder placeholders become the download's path; variables that
 * ask for the OAuth client ID, secret or region become the catalog's credential variables, so the
 * org's credentials go there at every start. The page shows the result as a filled-in form; nothing
 * runs before the user adds it.
 */

export interface GithubSetting {
  name: string;
  title?: string;
  description?: string;
  /** The plugin marks it secret: gctk keeps no secrets, so the server may not work without it. */
  secret?: boolean;
}

export interface GithubServer {
  name: string;
  description?: string;
  command: string;
  args: string[];
  /** Settings with their values (paths resolved); credential variables are not in here. */
  env: Record<string, string>;
  keys: { clientId?: string; secret?: string; region?: string };
  /** Settings the user still fills in (the plugin asks for them). */
  settings: GithubSetting[];
  /** Files the command needs that the download does not have (built or installed by npm). */
  missing: string[];
}

export interface GithubRepo {
  repo: string;
  source: string;
  folder: string;
  servers: GithubServer[];
  /** Skills the repository has (skills/<name>/SKILL.md); gctk does not install them. */
  skills: string[];
}

export const mcpServersDir = () => path.join(gctkHome(), "mcp-servers");

const MAX_DOWNLOAD = 60 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_TOTAL = 300 * 1024 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** owner/repo (and an optional branch or tag) from a GitHub link or "owner/repo". */
export function parseGithubUrl(input: string): { owner: string; repo: string; ref?: string } {
  const s = input.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const m = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?([^/\s]+)\/([^/\s#?]+)(?:\/tree\/([^\s?#]+))?$/.exec(s);
  if (!m || !NAME.test(m[1]!) || !NAME.test(m[2]!)) throw new GctkError("INVALID_INPUT", "Enter a GitHub repository link, e.g. https://github.com/MakingChatbots/genesys-cloud-plugins.");
  const ref = m[3] && /^[\w./-]{1,200}$/.test(m[3]) && !m[3].split("/").includes("..") ? m[3] : undefined;
  return { owner: m[1]!, repo: m[2]!, ...(ref ? { ref } : {}) };
}

const PLUGIN_ROOT = /\$\{(?:CLAUDE_PLUGIN_ROOT|CURSOR_PLUGIN_ROOT|PLUGIN_ROOT)\}/g;
const USER_CONFIG = /^\$\{user_config\.([\w.-]+)\}$/;

type Raw = { command?: unknown; args?: unknown; env?: unknown; url?: unknown; type?: unknown };
type UserConfig = Record<string, { title?: string; description?: string; sensitive?: boolean }>;

const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** Which credential a variable takes, from its name and the plugin's title for it. */
function credentialOf(name: string, title = ""): "clientId" | "secret" | "region" | undefined {
  const t = `${name} ${title}`;
  if (/client[\s_-]*id/i.test(t)) return "clientId";
  if (/secret/i.test(t)) return "secret";
  if (/region|environment/i.test(t) && !/path|dir|file/i.test(name)) return "region";
  return undefined;
}

/** The MCP servers a downloaded repository declares, in the order a plugin would load them. */
export function serversIn(folder: string): GithubServer[] {
  const found = new Map<string, { raw: Raw; userConfig: UserConfig; description?: string }>();
  const take = (servers: unknown, userConfig: UserConfig, description?: string) => {
    if (!servers || typeof servers !== "object") return;
    for (const [name, raw] of Object.entries(servers as Record<string, Raw>)) if (!found.has(name) && raw && typeof raw === "object") found.set(name, { raw, userConfig, description });
  };
  const pkg = readJson(path.join(folder, "package.json"));
  for (const manifest of [".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"]) {
    const m = readJson(path.join(folder, manifest));
    if (!m) continue;
    const uc = (m.userConfig && typeof m.userConfig === "object" ? m.userConfig : {}) as UserConfig;
    const desc = typeof m.description === "string" ? m.description : undefined;
    const ref = m.mcpServers;
    if (typeof ref === "string") {
      const file = path.resolve(folder, ref);
      if (file.startsWith(folder + path.sep)) take(readJson(file)?.mcpServers, uc, desc);
    } else take(ref, uc, desc);
  }
  for (const file of [".mcp.json", "mcp.json"]) take(readJson(path.join(folder, file))?.mcpServers, {}, typeof pkg?.description === "string" ? pkg.description : undefined);

  const out: GithubServer[] = [];
  for (const [name, { raw, userConfig, description }] of found) {
    if (typeof raw.command !== "string" || raw.url !== undefined) continue;
    const sub = (v: string) => v.replace(PLUGIN_ROOT, folder);
    const args = (Array.isArray(raw.args) ? raw.args : []).map((a) => sub(String(a)));
    const env: Record<string, string> = {};
    const keys: GithubServer["keys"] = {};
    const settings: GithubSetting[] = [];
    for (const [k, v] of Object.entries((raw.env && typeof raw.env === "object" ? raw.env : {}) as Record<string, unknown>)) {
      const value = String(v ?? "");
      const uc = USER_CONFIG.exec(value)?.[1];
      const meta = uc ? userConfig[uc] : undefined;
      const cred = credentialOf(k, meta?.title);
      if (cred && !keys[cred]) {
        keys[cred] = k;
        continue;
      }
      if (uc) {
        settings.push({ name: k, ...(meta?.title ? { title: meta.title } : {}), ...(meta?.description ? { description: meta.description } : {}), ...(meta?.sensitive ? { secret: true } : {}) });
        env[k] = "";
      } else env[k] = sub(value);
    }
    const missing = [...args, ...Object.values(env)].filter((p) => p.startsWith(folder + path.sep) && !fs.existsSync(p)).map((p) => path.relative(folder, p));
    out.push({ name, ...(description ? { description } : {}), command: sub(raw.command), args, env, keys, settings, missing });
  }
  return out;
}

/** Downloads the repository into mcp-servers/ (replacing an earlier download) and reads its MCP servers. */
export async function readGithubRepo(input: string, o: { fetch?: typeof fetch } = {}): Promise<GithubRepo> {
  const { owner, repo, ref } = parseGithubUrl(input);
  const res = await (o.fetch ?? fetch)(`https://github.com/${owner}/${repo}/archive/${ref ?? "HEAD"}.tar.gz`, { headers: { "User-Agent": "gctk" }, signal: AbortSignal.timeout(120_000) });
  if (res.status === 404) throw new GctkError("INVALID_INPUT", `GitHub has no public repository ${owner}/${repo}${ref ? ` with the branch ${ref}` : ""}.`);
  if (!res.ok) throw new GctkError("DOWNLOAD_FAILED", `GitHub answered ${res.status}; try again later.`);
  const tgz = Buffer.from(await res.arrayBuffer());
  if (tgz.length > MAX_DOWNLOAD) throw new GctkError("INVALID_INPUT", "The repository is too large for gctk to download (over 60 MB).");
  let files: Array<[string, Buffer, number]>;
  try {
    files = untar(zlib.gunzipSync(tgz, { maxOutputLength: MAX_TOTAL }));
  } catch {
    throw new GctkError("DOWNLOAD_FAILED", "GitHub's download could not be unpacked.");
  }
  if (files.length > MAX_FILES) throw new GctkError("INVALID_INPUT", "The repository has too many files for gctk to download.");

  const folder = path.join(mcpServersDir(), `${owner}__${repo}`);
  const tmp = `${folder}.new-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    for (const [name, data, mode] of files) {
      const rel = name.split("/").slice(1).join("/");
      if (!rel || rel.split("/").includes("..")) continue;
      const file = path.join(tmp, rel);
      if (!file.startsWith(tmp + path.sep)) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data, { mode: mode & 0o111 ? 0o755 : 0o644 });
    }
    fs.rmSync(folder, { recursive: true, force: true });
    fs.renameSync(tmp, folder);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  let skills: string[] = [];
  try {
    skills = fs.readdirSync(path.join(folder, "skills")).filter((n) => fs.existsSync(path.join(folder, "skills", n, "SKILL.md"))).sort();
  } catch {
    skills = [];
  }
  const servers = serversIn(folder);
  if (!servers.length) throw new GctkError("INVALID_INPUT", `${owner}/${repo} has no MCP server gctk can start (no .mcp.json, mcp.json or plugin manifest with a command). If it is an npm package, enter npx and the package name below instead.`);
  return { repo: `${owner}/${repo}`, source: `https://github.com/${owner}/${repo}`, folder, servers, skills };
}
