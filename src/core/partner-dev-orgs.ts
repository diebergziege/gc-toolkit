import fs from "node:fs";
import path from "node:path";
import { GctkError } from "./errors.js";
import { gctkHome } from "./paths.js";
import { readXlsx } from "./partner-radar.js";

/**
 * Partner dev orgs (UI page "Partner", tab "Dev orgs", decision 2026-11-09): the report of all
 * partner DEV/LAB orgs (one row per subscription line: account, part number, org ID, region, dates),
 * as CSV/TSV (Salesforce and Tableau export UTF-16 with tabs) or Excel. An org whose part numbers
 * include one of CX4_PARTS runs on CX4 (GC4 Dev/Lab), every other org on CX3. gctk keeps the last
 * upload in the gctk home (partner-dev-orgs.json) until the user removes it.
 */

/** The part numbers of the CX4 (GC4) Dev/Lab bundles; every other part number is CX3. */
export const CX4_PARTS = ["GC-170-DEV-LABBUC", "GC-170-DEV-LABBUP", "GC-170-DEV-LABBUV"] as const;

export type Generation = "cx4" | "cx3";

export interface DevOrg {
  orgId: string;
  partner: string;
  generation: Generation;
  parts: string[];
  products: string[];
  region?: string;
  billing?: string;
  /** YYYY-MM-DD when the file's date could be read, else as written. */
  start?: string;
  end?: string;
}

export interface DevOrgPartner {
  name: string;
  orgs: number;
  cx4: number;
  cx3: number;
  /** upgraded: every org on CX4; partly: some; cx3: none. */
  status: "upgraded" | "partly" | "cx3";
}

export interface DevOrgs {
  fileName: string;
  importedAt: string;
  orgs: DevOrg[];
  partners: DevOrgPartner[];
}

// ----------------------------------------------------------------- tables

/** Text of a CSV/TSV export: UTF-16 with BOM (Excel's "Unicode text", Salesforce) or UTF-8. */
function decode(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString("utf16le");
  // UTF-16 without BOM: every second byte of ASCII text is zero.
  if (buf.length > 3 && buf[1] === 0 && buf[3] === 0) return buf.toString("utf16le");
  return buf.toString("utf8").replace(/^\uFEFF/, "");
}

/** Rows of a delimited text, with quoted fields that may hold the delimiter, quotes and line breaks. */
export function readDelimited(text: string): string[][] {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delimiter = ["\t", ";", ","].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"', i++);
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) (row.push(field), (field = ""));
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) (row.push(field), rows.push(row));
  return rows;
}

const isXlsx = (buf: Buffer) => buf[0] === 0x50 && buf[1] === 0x4b;

// ----------------------------------------------------------------- report

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** "22/05/2026 00:00:00" (day first, as the report writes it), ISO dates and Excel day numbers. */
function dateOf(v: string): string | undefined {
  const s = v.trim();
  if (!s) return undefined;
  const dmy = /^(\d{1,2})[./](\d{1,2})[./](\d{4})\b/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (iso) return iso[1];
  const n = Number(s);
  if (Number.isFinite(n) && n > 20000 && n < 80000) return new Date(Math.round((n - 25569) * 86400) * 1000).toISOString().slice(0, 10);
  return s;
}

const COLUMNS = {
  partner: "account name",
  orgId: "org id",
  part: "part number",
  product: "product name",
  region: "aws region",
  billing: "billing category",
  start: "subscription start date",
  end: "subscription end date",
} as const;

/** Reads the dev org report. Refuses a file without account, org ID and part number columns. */
export function parseDevOrgs(buf: Buffer, fileName = "dev-orgs.csv", now = new Date()): DevOrgs {
  const rows = (isXlsx(buf) ? readXlsx(buf) : readDelimited(decode(buf))).filter((r) => r.some((c) => c.trim()));
  const header = (rows[0] ?? []).map(norm);
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, name]) => [k, header.indexOf(name)])) as Record<keyof typeof COLUMNS, number>;
  const required = { partner: "Account Name", orgId: "Org ID", part: "Part Number" } as const;
  const missing = (Object.keys(required) as Array<keyof typeof required>).filter((k) => col[k] < 0).map((k) => `"${required[k]}"`);
  if (missing.length) throw new GctkError("INVALID_INPUT", `This file has no column ${missing.join(", ")}. Upload the report of the partner dev orgs (Account Name, Part Number, Org ID, …).`);
  const cell = (r: string[], k: keyof typeof COLUMNS) => (col[k] >= 0 ? (r[col[k]] ?? "").replace(/\s+/g, " ").trim() : "");

  // One org per org ID and partner: the report repeats an org for each part it has.
  const byOrg = new Map<string, DevOrg>();
  for (const r of rows.slice(1)) {
    const partner = cell(r, "partner");
    const orgId = cell(r, "orgId");
    if (!partner || !orgId) continue;
    const key = `${orgId}\n${partner}`;
    const org = byOrg.get(key) ?? { orgId, partner, generation: "cx3", parts: [], products: [] };
    byOrg.set(key, org);
    const part = cell(r, "part").toUpperCase();
    const product = cell(r, "product");
    if (part && !org.parts.includes(part)) org.parts.push(part);
    if (product && !org.products.includes(product)) org.products.push(product);
    if ((CX4_PARTS as readonly string[]).includes(part)) org.generation = "cx4";
    org.region ||= cell(r, "region") || undefined;
    org.billing ||= cell(r, "billing") || undefined;
    const start = dateOf(cell(r, "start"));
    const end = dateOf(cell(r, "end"));
    if (start && (!org.start || start < org.start)) org.start = start;
    if (end && (!org.end || end > org.end)) org.end = end;
  }
  if (!byOrg.size) throw new GctkError("INVALID_INPUT", "The file has the report's columns but no orgs.");
  const orgs = [...byOrg.values()].sort((a, b) => a.partner.localeCompare(b.partner) || a.orgId.localeCompare(b.orgId));

  const partners = new Map<string, DevOrgPartner>();
  for (const o of orgs) {
    const p = partners.get(o.partner) ?? { name: o.partner, orgs: 0, cx4: 0, cx3: 0, status: "cx3" };
    partners.set(o.partner, p);
    p.orgs++;
    p[o.generation]++;
    p.status = p.cx4 === p.orgs ? "upgraded" : p.cx4 ? "partly" : "cx3";
  }
  return { fileName: path.basename(fileName) || "dev-orgs.csv", importedAt: now.toISOString(), orgs, partners: [...partners.values()] };
}

// ---------------------------------------------------------------- storage

export const devOrgsFile = () => path.join(gctkHome(), "partner-dev-orgs.json");

export function loadDevOrgs(): DevOrgs | null {
  try {
    return JSON.parse(fs.readFileSync(devOrgsFile(), "utf8")) as DevOrgs;
  } catch {
    return null;
  }
}

export function importDevOrgs(buf: Buffer, fileName?: string): DevOrgs {
  const data = parseDevOrgs(buf, fileName);
  fs.mkdirSync(gctkHome(), { recursive: true });
  const tmp = `${devOrgsFile()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, devOrgsFile());
  return data;
}

export function removeDevOrgs(): boolean {
  if (!fs.existsSync(devOrgsFile())) return false;
  fs.rmSync(devOrgsFile());
  return true;
}
