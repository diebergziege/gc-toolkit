import fs from "node:fs";
import path from "node:path";
import type { GenesysClient, Query } from "./client.js";
import { GctkError } from "./errors.js";
import { gctkHome } from "./paths.js";

/**
 * What the Demo ready page sent to an org, one record per request. Clean up and Refresh read it to
 * find what the page created or changed (never objects that only share a name), and the sections
 * read it to continue where a run stopped. Demo ready writes as soon as the user presses a button.
 */

export interface DemoRequest {
  method: string;
  path: string;
  query?: Query;
  body?: unknown;
  /** Local file uploaded to the presigned URL the request returns (WFM schedule import). */
  uploadFile?: string;
}

export interface DemoRecord {
  id: string;
  createdAt: string;
  profile: string;
  /** "demo ready · <section> · <user id> · <run>" */
  group: string;
  title: string;
  /** Marks one-off actions and carries previous values (demo-ready:before:{json}). */
  subject?: string;
  request: DemoRequest;
  status: "applied" | "failed";
  result?: { status?: number; body?: unknown; error?: string };
}

const dir = () => path.join(gctkHome(), "demo-ready");
/** Demo ready ran through plans before 0.23; their applied plans still count for Clean up. */
const legacyDir = () => path.join(gctkHome(), "plans");

let seq = 0;
function newId(now: Date): string {
  seq = (seq + 1) % 10_000;
  return `d-${now.getTime()}-${String(seq).padStart(4, "0")}`;
}

function readDir(d: string): unknown[] {
  if (!fs.existsSync(d)) return [];
  const out: unknown[] = [];
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(d, f), "utf8")));
    } catch {
      // half-written or foreign file
    }
  }
  return out;
}

function legacy(): DemoRecord[] {
  const out: DemoRecord[] = [];
  for (const raw of readDir(legacyDir())) {
    const p = raw as Partial<DemoRecord> & { status?: string; result?: DemoRecord["result"] };
    if (!p.group?.startsWith("demo ready · ") || (p.status !== "applied" && p.status !== "failed") || !p.request || !p.id || !p.createdAt || !p.profile) continue;
    out.push({ id: p.id, createdAt: p.createdAt, profile: p.profile, group: p.group, title: p.title ?? "", ...(p.subject ? { subject: p.subject } : {}), request: p.request, status: p.status, ...(p.result ? { result: p.result } : {}) });
  }
  return out;
}

/** Newest first, like the plan list it replaces. */
export function listRecords(f: { profile?: string; group?: string; status?: DemoRecord["status"]; limit?: number } = {}): DemoRecord[] {
  const own = readDir(dir()) as DemoRecord[];
  const seen = new Set(own.map((r) => r.id));
  const all = [...own, ...legacy().filter((r) => !seen.has(r.id))];
  return all
    .filter((r) => (!f.profile || r.profile === f.profile) && (!f.group || r.group === f.group) && (!f.status || r.status === f.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, f.limit ?? 1000);
}

/** Copies the Demo ready plans of earlier versions into the step log, so plans/ is no longer needed. */
export function migrateLegacyPlans(): number {
  const own = new Set((readDir(dir()) as DemoRecord[]).map((r) => r.id));
  let n = 0;
  for (const r of legacy()) {
    if (own.has(r.id)) continue;
    save(r);
    n++;
  }
  return n;
}

function save(r: DemoRecord): void {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir(), `${r.id}.json`), `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
}

function truncate(body: unknown): unknown {
  const s = JSON.stringify(body ?? null);
  return s.length > 20_000 ? { truncated: true, preview: s.slice(0, 20_000) } : body;
}

/** Sends the file to the presigned URL of the upload request (Genesys' upload host or S3, https only). */
async function upload(file: string, response: unknown, region: string, fetchImpl: typeof fetch): Promise<void> {
  const r = (response ?? {}) as { url?: string; presignedUrl?: string; headers?: Record<string, string> };
  const target = r.url ?? r.presignedUrl;
  if (!target) throw new GctkError("UPLOAD_FAILED", "The upload request returned no presigned URL.");
  const url = new URL(target);
  const allowed = url.hostname === `fileupload.${region}` || url.hostname.endsWith(`.${region}`) || /(^|\.)amazonaws\.com$/.test(url.hostname);
  if (url.protocol !== "https:" || !allowed) throw new GctkError("UPLOAD_FAILED", `Refusing to upload to unexpected host ${url.hostname}.`);
  const res = await fetchImpl(url, { method: "PUT", headers: { ...(r.headers ?? {}) }, body: fs.readFileSync(file) });
  if (!res.ok) throw new GctkError("UPLOAD_FAILED", `Upload failed with HTTP ${res.status}.`);
}

/** Sends one step to the org and records it, applied or failed. */
export async function sendStep(
  client: GenesysClient,
  step: { group: string; title: string; subject?: string; request: DemoRequest },
  opts: { uploadFetch?: typeof fetch; now?: Date } = {},
): Promise<DemoRecord> {
  const now = opts.now ?? new Date();
  const rec: DemoRecord = { id: newId(now), createdAt: now.toISOString(), profile: client.profile.name, group: step.group, title: step.title, ...(step.subject ? { subject: step.subject } : {}), request: step.request, status: "failed" };
  try {
    const { method, path: p, query, body, uploadFile } = step.request;
    const res = await client.request(method, p, query, body);
    if (uploadFile) await upload(uploadFile, res.body, client.profile.region, opts.uploadFetch ?? fetch);
    rec.status = "applied";
    rec.result = { status: res.status, body: truncate(res.body) };
  } catch (err) {
    rec.result = { error: err instanceof GctkError ? err.format() : String(err) };
  }
  save(rec);
  return rec;
}
