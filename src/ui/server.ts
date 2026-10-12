import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { deleteCredentials, hasStoredCredentials, storeCredentials } from "../core/credentials.js";
import { GctkError, formatError } from "../core/errors.js";
import { GenesysClient } from "../core/client.js";
import {
  assertProfileName,
  getActiveProfileName,
  getUiPort,
  listProfiles,
  loadProfile,
  removeProfile,
  saveProfile,
  setActiveProfileName,
  TIERS,
  type Profile,
  type Tier,
  validPort,
} from "../core/profiles.js";
import { COACHING_TEMPLATES, DEMO_SECTIONS, LEARNING_TEMPLATES, demoSection, runDemoSection, USER_ID_RE } from "../core/demo-ready.js";
import { monitorOrg, type MonitorReport } from "../core/monitoring.js";
import { addLocation, cleanEnv, moveToKeychain, removeLocation, linkToOrg, removeServer, repairServer, restoreSkill, restoreToFile, scanAiSetup, setCredentials, toolTemplates, updateSecret } from "../core/ai-setup.js";
import { ensureStableGctk, runningGctkJs } from "../core/stable-gctk.js";
import { checkGctk, checkUpdates, type GctkVersion, type Program, updateGctk, updateProgram } from "../core/updates.js";
import { dataInfo, dataPath } from "../core/data-info.js";
import { checkPrerequisites, commandLog, commandStatus, DEMO_TYPES, deployDemo, joinDemo, leaveDemo, listDemos, orgDemoStatus, orgDivisions, orgUsers, orgWhatsApp, registerDeployment, removeDemo, startCommand, stopAllLocal, stopCommand, takeSnapshot } from "../core/demos.js";
import { claudeAppSkills, exportClaudeAppSkills } from "../core/claude-skills.js";
import { axlStatus, getWorkshop, type ProjectTool, listAxlSessions, removeWorkshop, saveHarnessCommand, saveWorkshop, sessionsDirOf, setupWorkshopFolder, syncClaudeApp, useInClaudeApp } from "../core/axl.js";
import { gctkHome } from "../core/paths.js";
import { REGIONS, resolveRegion } from "../core/regions.js";
import indexHtml from "./index.html";
import { openBrowser, openInCursor } from "./launcher.js";
import { environmentFor, INDUSTRIES, LANGS, parseSiteQuery, readLogo, saveLogo, SITE_HOST, siteCsp, siteHtml } from "./site.js";

declare const __GCTK_VERSION__: string;
const VERSION = typeof __GCTK_VERSION__ === "string" ? __GCTK_VERSION__ : "dev";
const MAX_BODY = 1024 * 1024;
/** Logo uploads on the Website page arrive base64 encoded in JSON. */
const MAX_UPLOAD_BODY = 4 * 1024 * 1024;

export interface UiServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

/** A port the UI may take: free on 127.0.0.1 now (the check closes again right away). */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

type Json = Record<string, unknown>;
type Handler = (ctx: { params: Record<string, string>; query: URLSearchParams; body: Json }) => Promise<unknown> | unknown;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One client per org, so its token is reused; dropped when the org's credentials change. */
const clients = new Map<string, GenesysClient>();
function clientFor(profile: string): GenesysClient {
  let c = clients.get(profile);
  if (!c) {
    c = new GenesysClient(loadProfile(profile), { source: "ui" });
    clients.set(profile, c);
  }
  return c;
}
const currentUser = () => os.userInfo().username;

function profileView(p: Profile) {
  return {
    name: p.name,
    region: p.region,
    tier: p.tier,
    description: p.description,
    credentials: p.credentials,
    credentialsStored: hasStoredCredentials(p),
    active: getActiveProfileName() === p.name,
  };
}

function str(body: Json, key: string, required = true): string {
  const v = body[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (required) throw new HttpError(400, `"${key}" is required.`);
  return "";
}

const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];
function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)"))}$`);
  routes.push({ method, pattern, keys, handler });
}

// ------------------------------------------------------------------ API

route("GET", "/api/overview", () => ({
  version: VERSION,
  user: currentUser(),
  activeProfile: getActiveProfileName() ?? null,
  profiles: listProfiles().map((n) => {
    try {
      return profileView(loadProfile(n));
    } catch (err) {
      return { name: n, error: formatError(err) };
    }
  }),
  /** gctk's folder (Orgs page and Your data). */
  home: gctkHome(),
  /** Runs in the background (gctk ui), so the top bar offers Stop UI. */
  persistent: Boolean(process.env.GCTK_UI_DAEMON),
  tiers: TIERS,
}));

// Is a newer gctk out? The top bar asks once an hour (GitHub); an update by click only for npx.
const GCTK_TTL_MS = 60 * 60 * 1000;
let gctkCache: { at: number; value: Promise<GctkVersion> } | undefined;
const gctkVersion = (refresh = false) => {
  if (refresh || !gctkCache || Date.now() - gctkCache.at > GCTK_TTL_MS) gctkCache = { at: Date.now(), value: checkGctk(VERSION) };
  return gctkCache.value;
};
route("GET", "/api/gctk-version", ({ query }) => gctkVersion(query.get("refresh") === "1"));
route("POST", "/api/gctk-version/update", async () => {
  const v = await gctkVersion();
  const r = updateGctk(v.install);
  gctkCache = undefined;
  return r;
});

// Demo ready: fills one agent's home screen with demo data. A run writes to the org as soon as the
// user pressed the button and records what it did, so Clean up can undo it.
route("GET", "/api/demo", () => ({ sections: DEMO_SECTIONS, coachingTemplates: COACHING_TEMPLATES, learningTemplates: LEARNING_TEMPLATES }));

route("GET", "/api/demo/users", async ({ query }) => {
  const client = clientFor(str(Object.fromEntries(query), "profile"));
  const { first, paged } = await client.getAll("/api/v2/users", { state: "active", pageSize: 100, sortOrder: "ASC" }, 2000);
  type Row = { id?: string; name?: string; email?: string; title?: string };
  const rows = (paged?.items ?? (first.body as { entities?: Row[] }).entities ?? []) as Row[];
  return rows.filter((u) => u.id && u.name).map((u) => ({ id: u.id, name: u.name, email: u.email, title: u.title })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
});

const demoUser = (q: Json) => {
  const userId = str(q, "userId");
  if (!USER_ID_RE.test(userId)) throw new HttpError(400, "userId must be a user id.");
  return userId;
};

route("GET", "/api/demo/:section/status", async ({ params, query }) => {
  const q = Object.fromEntries(query);
  const section = demoSection(params.section!);
  const userId = demoUser(q);
  return section.status(clientFor(str(q, "profile")), userId);
});

route("POST", "/api/demo/:section/run", async ({ params, body }) => {
  const section = demoSection(params.section!);
  return runDemoSection(section, body.input ?? {}, { client: clientFor(str(body, "profile")), userId: demoUser(body), agentName: str(body, "agentName", false) || undefined });
});

// Monitoring: object counts next to the org's own limits (read-only). Cached per profile so
// opening the page again does not cost ~30 requests; the Refresh button passes refresh=1.
const MONITOR_TTL_MS = 5 * 60 * 1000;
const monitorCache = new Map<string, { at: number; report: MonitorReport }>();
route("GET", "/api/monitoring", async ({ query }) => {
  const profile = str(Object.fromEntries(query), "profile");
  const cached = monitorCache.get(profile);
  if (cached && query.get("refresh") !== "1" && Date.now() - cached.at < MONITOR_TTL_MS) return cached.report;
  const report = await monitorOrg(clientFor(profile));
  monitorCache.set(profile, { at: Date.now(), report });
  return report;
});

// AXL workshops: a list, each with the org the AVA harness works on and the folder the user opens
// in Cursor. Saving a workshop writes its harness server into the folder's own .cursor/mcp.json
// (never the global one); nothing else outside the gctk home is written.
/** The folder's ava-harness server runs this gctk (dist/gctk.js), not a development run. */
/** Config entries gctk writes start the copy in the gctk home, which plugin updates do not delete. */
const installedGctk = () => {
  const js = runningGctkJs();
  return js ? ensureStableGctk(js) : undefined;
};
/** After a change of org or folder: rewrite the folder's harness server right away, and the Claude app's when it works on this workshop. */
const applyWorkshop = (id: string) => {
  const w = getWorkshop(id);
  const gctkJs = installedGctk();
  if (gctkJs) syncClaudeApp(id, gctkJs);
  return gctkJs && w.profile && w.folder ? setupWorkshopFolder(id, gctkJs) : false;
};
const pickStr = (body: Json, k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
/**
 * Project fields from the page. Tools are picked by template id from the server's own scan (or
 * "keep:<name>" for one the project has already), never sent as commands.
 */
const projectFields = (body: Json, existing: ProjectTool[] = []) => {
  const out: { lab?: boolean; harness?: boolean; tools?: ProjectTool[]; confirmProduction?: boolean } = {};
  if (typeof body.lab === "boolean") out.lab = body.lab;
  if (typeof body.harness === "boolean") out.harness = body.harness;
  if (body.confirmProduction === true) out.confirmProduction = true;
  if (Array.isArray(body.tools)) {
    const ids = body.tools.filter((x): x is string => typeof x === "string");
    const all = toolTemplates();
    const kept = ids.filter((id) => id.startsWith("keep:")).map((id) => existing.find((t) => t.name === id.slice(5)));
    const unknown = ids.filter((id) => !id.startsWith("keep:") && !all.some((t) => t.id === id));
    if (unknown.length || kept.some((t) => !t)) throw new HttpError(400, "A tool is no longer in your editor configs; refresh the page.");
    out.tools = [...(kept as ProjectTool[]), ...all.filter((t) => ids.includes(t.id))];
  }
  return out;
};
const shownWorkshop = (id: string) => {
  const w = getWorkshop(id);
  if (!w.folder || !fs.existsSync(w.folder)) throw new HttpError(400, "Set up the workshop folder first.");
  return w;
};
route("GET", "/api/axl", () => axlStatus());
route("PUT", "/api/axl/settings", ({ body }) => (saveHarnessCommand(pickStr(body, "harnessCommand") ?? ""), axlStatus()));
route("GET", "/api/axl/tool-templates", () => toolTemplates());
route("POST", "/api/axl/workshops", ({ body }) => {
  const w = saveWorkshop({ name: pickStr(body, "name"), profile: pickStr(body, "profile"), folder: pickStr(body, "folder"), ...projectFields(body) });
  return { ...axlStatus(), id: w.id, folderUpdated: applyWorkshop(w.id) };
});
route("PUT", "/api/axl/workshops/:id", ({ params, body }) => {
  const fields = projectFields(body, getWorkshop(params.id!).tools);
  const w = saveWorkshop({ id: params.id!, name: pickStr(body, "name"), profile: pickStr(body, "profile"), folder: pickStr(body, "folder"), brief: body.brief, ...fields });
  const touched = pickStr(body, "profile") !== undefined || pickStr(body, "folder") !== undefined || fields.harness !== undefined || fields.tools !== undefined;
  return { ...axlStatus(), id: w.id, folderUpdated: touched ? applyWorkshop(w.id) : false };
});
route("DELETE", "/api/axl/workshops/:id", ({ params }) => {
  const r = removeWorkshop(params.id!);
  return { ...axlStatus(), ...r };
});
// The Claude app has one ava-harness for every chat and Cowork session: the workshop it works on ("" removes gctk's entry).
route("POST", "/api/axl/claude-app", ({ body }) => {
  const gctkJs = installedGctk();
  if (!gctkJs) throw new HttpError(400, "Setting up the Claude app needs the installed gctk (dist/gctk.js), not a development run.");
  const changed = useInClaudeApp(pickStr(body, "workshop") || undefined, gctkJs);
  return { ...axlStatus(), changed };
});
route("POST", "/api/axl/workshops/:id/setup-folder", ({ params }) => {
  const gctkJs = installedGctk();
  if (!gctkJs) throw new HttpError(400, "Setting up the folder needs the installed gctk (dist/gctk.js), not a development run.");
  return { ...axlStatus(), id: params.id, folderUpdated: setupWorkshopFolder(params.id!, gctkJs) };
});
route("POST", "/api/axl/workshops/:id/reveal", async ({ params, body }) => {
  const w = shownWorkshop(params.id!);
  const name = str(body, "session", false);
  const dir = sessionsDirOf(w)!;
  if (name && !listAxlSessions(dir).some((x) => x.name === name)) throw new HttpError(400, "Unknown session.");
  return { opened: await openBrowser(name ? path.join(dir, name) : w.folder!) };
});
// Skills for the Claude app: gctk zips them for the user to upload in the app (it cannot reach the account).
route("GET", "/api/claude-app/skills", () => claudeAppSkills());
route("POST", "/api/claude-app/skills/export", ({ body }) => {
  const names = Array.isArray(body.names) ? body.names.filter((x): x is string => typeof x === "string") : [];
  return { ...claudeAppSkills(), exported: exportClaudeAppSkills(names) };
});
route("POST", "/api/claude-app/skills/reveal", async () => {
  const dir = claudeAppSkills().out;
  if (!fs.existsSync(dir)) throw new HttpError(400, "No zips yet.");
  return { opened: await openBrowser(dir) };
});
// AI setup: the editors' MCP config files and skills. Secrets reach the browser only masked; the
// fixes below change the user's config files and exist only here, behind the user's click.
const serverOf = (body: Json) => ({ file: str(body, "file"), section: str(body, "section"), name: str(body, "name") });
route("GET", "/api/ai-setup", () => scanAiSetup());
route("POST", "/api/ai-setup/locations", ({ body }) => (addLocation(str(body, "path")), scanAiSetup()));
route("POST", "/api/ai-setup/locations/remove", ({ body }) => (removeLocation(str(body, "path")), scanAiSetup()));
route("POST", "/api/ai-setup/fix", ({ body }) => {
  const a = serverOf(body);
  const fix = str(body, "fix");
  if (fix === "keychain") {
    const gctkJs = installedGctk();
    if (!gctkJs) throw new HttpError(400, "Moving a secret to the keychain needs the installed gctk (dist/gctk.js), not a development run.");
    moveToKeychain(a, { gctkJs });
  } else if (fix === "restore") restoreToFile(a);
  else if (fix === "remove") removeServer(a);
  else if (fix === "clean-env") cleanEnv(a);
  else if (fix === "repair") {
    const gctkJs = installedGctk();
    if (!gctkJs) throw new HttpError(400, "Repairing needs the installed gctk (dist/gctk.js), not a development run.");
    repairServer(a, { gctkJs });
  } else throw new HttpError(400, 'fix must be "keychain", "restore", "remove", "clean-env" or "repair".');
  return scanAiSetup();
});
route("POST", "/api/ai-setup/skills/restore", ({ body }) => (restoreSkill(str(body, "id")), scanAiSetup()));
// Links a server to an org on the Orgs page (an existing one, or its own credentials as a new org).
route("POST", "/api/ai-setup/link", ({ body }) => {
  const gctkJs = installedGctk();
  if (!gctkJs) throw new HttpError(400, "Linking needs the installed gctk (dist/gctk.js), not a development run.");
  const n = body.newOrg && typeof body.newOrg === "object" ? (body.newOrg as Json) : undefined;
  const r = linkToOrg(serverOf(body), {
    gctkJs,
    profile: str(body, "profile", false) || undefined,
    useOrgSecret: body.useOrgSecret === true,
    ...(n ? { newOrg: { name: str(n, "name"), tier: str(n, "tier") as Tier, region: str(n, "region", false) || undefined } } : {}),
  });
  if (r.created) clients.delete(r.profile);
  return { ...scanAiSetup(), linked: r };
});
route("POST", "/api/ai-setup/credentials", ({ body }) => {
  const keychain = body.keychain !== false;
  setCredentials(serverOf(body), { profile: str(body, "profile", false) || undefined, clientId: str(body, "clientId", false), secret: str(body, "secret", false), region: str(body, "region", false), keychain }, { gctkJs: installedGctk() });
  return scanAiSetup();
});
// Updates of the programs behind Cursor's servers (ava-mcp, gctk). The check asks GitHub and PyPI,
// so the page loads it on its own; the update runs only on a click and names the program by id.
const UPDATES_TTL_MS = 60 * 60 * 1000;
let updatesCache: { at: number; programs: Program[] } | undefined;
route("GET", "/api/ai-setup/updates", async ({ query }) => {
  if (!updatesCache || query.get("refresh") === "1" || Date.now() - updatesCache.at > UPDATES_TTL_MS) updatesCache = { at: Date.now(), programs: await checkUpdates(scanAiSetup().servers) };
  return { programs: updatesCache.programs };
});
route("POST", "/api/ai-setup/update", async ({ body }) => {
  const result = await updateProgram(str(body, "id"), scanAiSetup().servers);
  updatesCache = undefined;
  return { result, programs: (updatesCache = { at: Date.now(), programs: await checkUpdates(scanAiSetup().servers) }).programs };
});
route("PUT", "/api/ai-setup/secrets/:account", ({ params, body }) => {
  const values = body.values;
  if (!values || typeof values !== "object") throw new HttpError(400, '"values" is required.');
  updateSecret(params.account!, values as Json);
  return scanAiSetup();
});

// Demos: whole demos deployed into an org. Snapshot, deploy and remove run as background jobs
// (a deploy takes about a minute); the page polls their progress.
const jobs = new Map<string, { lines: string[]; done: boolean; error?: string; result?: unknown }>();
const startJob = (work: (log: (l: string) => void) => Promise<unknown>) => {
  const id = crypto.randomBytes(6).toString("hex");
  const job = { lines: [] as string[], done: false } as { lines: string[]; done: boolean; error?: string; result?: unknown };
  jobs.set(id, job);
  work((l) => job.lines.push(l))
    .then((r) => (job.result = r))
    .catch((err) => (job.error = formatError(err)))
    .finally(() => (job.done = true));
  return { job: id };
};
/** Parameter values from the page: string values only. */
const stringMap = (x: unknown): Record<string, string> =>
  x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, v]) => typeof v === "string") as Array<[string, string]>) : {};
/** The presenter's customer persona from the page (checked in demos.ts). */
const personaOf = (body: Json) => {
  const p = body.persona && typeof body.persona === "object" ? (body.persona as Json) : undefined;
  return p ? { salutation: String(p.salutation ?? ""), firstName: String(p.firstName ?? ""), lastName: String(p.lastName ?? "") } : undefined;
};
route("GET", "/api/demos", () => ({ demos: listDemos(), types: DEMO_TYPES }));
route("GET", "/api/demos/jobs/:job", ({ params }) => {
  const j = jobs.get(params.job!);
  if (!j) throw new HttpError(404, "Unknown job.");
  return j;
});
route("GET", "/api/demos/:id/org", async ({ params, query }) => {
  const profile = str(Object.fromEntries(query), "profile");
  // status: the demo's deployment in this org, from the org's own registry (whoever deployed it).
  const [prerequisites, users, divisions, whatsapp, status] = await Promise.all([checkPrerequisites(params.id!, profile), orgUsers(profile), orgDivisions(profile), orgWhatsApp(profile).catch(() => []), orgDemoStatus(params.id!, profile)]);
  return { prerequisites, users, divisions, whatsapp, status, commands: commandStatus(params.id!) };
});
route("POST", "/api/demos/:id/snapshot", ({ params }) => startJob((log) => takeSnapshot(params.id!, { log })));
route("POST", "/api/demos/:id/deploy", ({ params, body }) =>
  startJob((log) => deployDemo(params.id!, { profile: str(body, "profile"), divisionId: str(body, "divisionId", false) || undefined, presenterId: str(body, "presenterId", false) || undefined, whatsappIntegrationId: str(body, "whatsappIntegrationId", false) || undefined, params: stringMap(body.params), channel: str(body, "channel", false) || undefined, update: body.update === true, persona: personaOf(body), log })),
);
route("POST", "/api/demos/:id/join", ({ params, body }) => joinDemo(params.id!, { profile: str(body, "profile"), presenterId: str(body, "presenterId"), persona: personaOf(body), params: stringMap(body.params) }));
route("POST", "/api/demos/:id/leave", ({ params, body }) => leaveDemo(params.id!, { profile: str(body, "profile"), presenterId: str(body, "presenterId") }));
route("POST", "/api/demos/:id/register", ({ params, body }) => registerDeployment(params.id!, str(body, "profile")));
route("POST", "/api/demos/:id/remove", ({ params, body }) => startJob((log) => removeDemo(params.id!, { profile: str(body, "profile"), log })));
route("GET", "/api/demos/:id/commands", ({ params }) => commandStatus(params.id!));
route("POST", "/api/demos/:id/commands/:cmd/start", ({ params, body }) => startCommand(params.id!, params.cmd!, str(body, "profile")));
route("POST", "/api/demos/:id/commands/:cmd/stop", async ({ params }) => ({ stopped: await stopCommand(params.id!, params.cmd!) }));
route("GET", "/api/demos/:id/commands/:cmd/log", ({ params }) => ({ log: commandLog(params.id!, params.cmd!) }));

// Your data: where gctk keeps what (paths, sizes, keychain entries by name).
route("GET", "/api/data", () => dataInfo());
route("POST", "/api/data/open", async ({ body }) => {
  const p = dataPath(str(body, "key"));
  if (!p) throw new HttpError(400, "Unknown place.");
  return { opened: await openBrowser(fs.statSync(p).isDirectory() ? p : path.dirname(p)) };
});

route("POST", "/api/axl/workshops/:id/open-cursor", async ({ params }) => ({ opened: await openInCursor(shownWorkshop(params.id!).folder!) }));

route("POST", "/api/profiles", async ({ body }) => {
  const name = str(body, "name");
  assertProfileName(name);
  if (listProfiles().includes(name)) throw new HttpError(409, `Profile "${name}" already exists.`);
  const tier = str(body, "tier") as Tier;
  if (!TIERS.includes(tier)) throw new HttpError(400, `Unknown tier "${tier}".`);
  const profile: Profile = {
    name,
    region: resolveRegion(str(body, "region")),
    tier,
    description: str(body, "description", false) || undefined,
    credentials: "keychain",
  };
  saveProfile(profile);
  if (!getActiveProfileName()) setActiveProfileName(name);
  const clientId = str(body, "clientId", false);
  const clientSecret = str(body, "clientSecret", false);
  if (clientId && clientSecret) return verifyCredentials(profile, clientId, clientSecret);
  return { profile: profileView(profile) };
});

route("PUT", "/api/profiles/:name/credentials", async ({ params, body }) =>
  verifyCredentials(loadProfile(params.name!), str(body, "clientId"), str(body, "clientSecret")),
);

async function verifyCredentials(profile: Profile, clientId: string, clientSecret: string) {
  storeCredentials(profile, { clientId, clientSecret });
  clients.delete(profile.name);
  try {
    const org = (await clientFor(profile.name).get<{ id?: string; name?: string }>("/api/v2/organizations/me")).body;
    return { profile: profileView(profile), verified: true, organization: { id: org.id, name: org.name } };
  } catch (err) {
    return { profile: profileView(profile), verified: false, error: formatError(err) };
  }
}

route("POST", "/api/profiles/:name/activate", ({ params }) => {
  setActiveProfileName(params.name!);
  return { activeProfile: params.name };
});

route("DELETE", "/api/profiles/:name", ({ params }) => {
  const profile = loadProfile(params.name!);
  if (profile.credentials === "keychain") deleteCredentials(profile.name);
  removeProfile(profile.name);
  clients.delete(profile.name);
  return { removed: profile.name };
});

// ------------------------------------------------------------ website

route("GET", "/api/site", () => ({
  host: SITE_HOST,
  langs: LANGS,
  industries: INDUSTRIES.map((i) => ({ id: i.id, label: i.label, brand: i.brand, color: i.color, headline: i.copy.en.heroTitle })),
  // The region decides which Messenger loads; it defaults to the org the user works on.
  regions: Object.entries(REGIONS).map(([key, domain]) => ({ key, domain, environment: environmentFor(domain) })),
  defaultDomain: (() => {
    const active = getActiveProfileName();
    try {
      return active ? loadProfile(active).region : "mypurecloud.de";
    } catch {
      return "mypurecloud.de";
    }
  })(),
}));

route("POST", "/api/site/files", ({ body }) => {
  try {
    return { logo: saveLogo(str(body, "data")) };
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
});

// --------------------------------------------------------------- server

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    ...headers,
  });
  res.end(text);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function readBody(req: http.IncomingMessage, max = MAX_BODY): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
  } catch {
    throw new HttpError(400, "Body must be JSON.");
  }
}

let shutdownHook: (() => void) | undefined;
let portMover: ((port: number) => Promise<string>) | undefined;
// The UI's address: it keeps its port so it can be bookmarked; another free port moves it there now.
route("GET", "/api/ui/port", async ({ query }) => {
  const want = Number(query.get("check"));
  return { port: currentPort, saved: getUiPort() ?? null, default: DEFAULT_UI_PORT, movable: Boolean(portMover), ...(query.has("check") ? { free: validPort(want) && (want === currentPort || (await portFree(want))) } : {}) };
});
route("POST", "/api/ui/port", async ({ body }) => {
  const port = Number(body.port);
  if (!validPort(port)) throw new HttpError(400, "Choose a port between 1024 and 65535.");
  if (!portMover) throw new HttpError(400, "This UI cannot change its port.");
  if (port === currentPort) return { url: null, port };
  return { url: await portMover(port), port };
});
route("POST", "/api/shutdown", () => {
  if (!shutdownHook) throw new HttpError(400, "This UI runs in a terminal; stop it there with Ctrl+C.");
  setTimeout(shutdownHook, 200);
  return { stopping: true };
});

/**
 * Readable address of the UI: browsers and macOS resolve every *.localhost name to this machine,
 * so http://gctk.localhost:4285/ reaches the loopback server without any setup (4285 = GCTK).
 */
export const UI_HOST = "gctk.localhost";
export const DEFAULT_UI_PORT = 4285;
export const uiUrl = (port: number, token: string) => `http://${UI_HOST}:${port}/#token=${token}`;

let currentPort = 0;

export async function startUi(
  opts: {
    port?: number;
    preferPort?: number;
    token?: string;
    onActivity?: () => void;
    onShutdown?: () => void;
    /** The user moved the UI to another port (page "Your data"); undefined: it cannot move (tests). */
    onPortChange?: (port: number) => void;
  } = {},
): Promise<UiServer> {
  shutdownHook = opts.onShutdown;
  const token = opts.token ?? crypto.randomBytes(24).toString("base64url");
  let port = 0;
  const allowedHosts = () => [`${UI_HOST}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`];

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      // The demo website has its own origin: it serves only the page and its logos, never the API,
      // so the Messenger script it loads never shares an origin with the UI's session token.
      if (req.headers.host === `${SITE_HOST}:${port}`) {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        if (req.method !== "GET") return send(res, 405, { error: "Method not allowed." });
        if (url.pathname === "/site") {
          const nonce = crypto.randomBytes(16).toString("base64");
          const o = parseSiteQuery(url.searchParams);
          return send(res, 200, siteHtml(o, nonce), { "Content-Security-Policy": siteCsp(o, nonce), "X-Frame-Options": "DENY" });
        }
        const logo = url.pathname.startsWith("/site/logo/") ? readLogo(url.pathname.slice("/site/logo/".length)) : undefined;
        if (logo) {
          res.writeHead(200, { "Content-Type": logo.type, "Cache-Control": "max-age=86400", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" });
          return res.end(logo.body);
        }
        return send(res, 404, { error: "Not found." });
      }
      // DNS rebinding: only accept requests addressed to this loopback server.
      if (!allowedHosts().includes(req.headers.host ?? "")) return send(res, 421, { error: "Unexpected Host header." });
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/") {
        const nonce = crypto.randomBytes(16).toString("base64");
        return send(res, 200, indexHtml.replaceAll("__NONCE__", nonce), {
          "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        });
      }
      if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found." });

      if (!safeEqual(String(req.headers["x-gctk-token"] ?? ""), token)) return send(res, 401, { error: "Missing or wrong session token." });
      opts.onActivity?.();
      if (req.method !== "GET") {
        const origin = req.headers.origin;
        if (origin && !allowedHosts().some((h) => origin === `http://${h}`)) return send(res, 403, { error: "Cross-origin request refused." });
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
          return send(res, 415, { error: "Content-Type must be application/json." });
        }
      }

      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
        const body = req.method === "GET" ? {} : await readBody(req, /\/files$/.test(url.pathname) ? MAX_UPLOAD_BODY : MAX_BODY);
        return send(res, 200, (await r.handler({ params, query: url.searchParams, body })) ?? {});
      }
      return send(res, 404, { error: "Not found." });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (err instanceof GctkError) return send(res, 400, { error: err.format(), code: err.code });
      return send(res, 500, { error: formatError(err) });
    }
  };

  let server = http.createServer(handler);
  const listen = (srv: http.Server, p: number) =>
    new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(p, "127.0.0.1", () => {
        srv.off("error", reject);
        resolve();
      });
    });
  const busy = (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") throw err;
  };
  if (opts.port !== undefined) await listen(server, opts.port);
  else if (opts.preferPort !== undefined) {
    // The kept port; when something else has it, the next free one nearby (still easy to read), else any.
    let ok = false;
    for (let p = opts.preferPort; p < opts.preferPort + 20 && p <= 65535 && !ok; p++) ok = await listen(server, p).then(() => true, (err) => (busy(err), false));
    if (!ok) await listen(server, 0);
  } else await listen(server, 0);
  port = (server.address() as AddressInfo).port;
  currentPort = port;
  portMover = opts.onPortChange
    ? async (next) => {
        // The new server listens first, so a taken port changes nothing; the old one closes after this answer.
        const moved = http.createServer(handler);
        await listen(moved, next).catch((err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") throw new HttpError(400, `Port ${next} is in use by another program. Choose another one.`);
          throw err;
        });
        const old = server;
        server = moved;
        port = next;
        currentPort = next;
        opts.onPortChange?.(next);
        setTimeout(() => {
          old.close();
          old.closeIdleConnections();
        }, 500).unref();
        return uiUrl(next, token);
      }
    : undefined;
  return {
    get port() {
      return port;
    },
    token,
    // The token travels in the fragment, so it never reaches server logs or referrers.
    get url() {
      return uiUrl(port, token);
    },
    close: () =>
      new Promise((resolve) => {
        void stopAllLocal();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
