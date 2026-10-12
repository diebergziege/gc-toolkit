import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import YAML from "yaml";
import { GctkError } from "./errors.js";
import { gctkHome } from "./paths.js";

/**
 * Skills for the Claude app (UI page "Claude app", decision 2026-10-12). Cowork keeps skills in the
 * user's Claude account; they are uploaded as zip files in the app, one skill per zip, and gctk cannot
 * reach them there. So gctk makes the zips: the AVA skills ava-mcp keeps in ~/.cursor/skills (an
 * ava-mcp update refreshes them there) and the AXL lab facilitator. Each export records a fingerprint
 * of every skill it zipped, so the page shows which skills changed since the zips the user uploaded.
 *
 * The upload refuses some things Cursor accepts: XML-like tags in the frontmatter (`<slug>`) become
 * `{slug}` in the zip; the source folder is never changed.
 */

/** The skills the lab needs: every AVA skill, and the facilitator. */
const WANTED = (name: string) => name.startsWith("ava-") || name === "axl-lab-facilitator";
const SKIP = new Set([".DS_Store", "Thumbs.db", ".git"]);

export interface AppSkill {
  name: string;
  /** Where it is read from. */
  dir: string;
  files: number;
  /** new: never zipped by gctk; changed: differs from the last zip; same: as last zipped. */
  status: "new" | "changed" | "same";
  exportedAt?: string;
  /** What the zip changes so the upload accepts it. */
  fixes: string[];
  /** What the upload may still refuse. */
  problems: string[];
}

export interface AppSkills {
  /** Where the skills are read from (~/.cursor/skills). */
  source: string;
  /** Where the zips go. */
  out: string;
  skills: AppSkill[];
}

export const appSkillsDir = () => path.join(gctkHome(), "claude-app-skills");
const recordFile = () => path.join(appSkillsDir(), "exported.json");
type Exported = Record<string, { hash: string; at: string }>;

function readRecord(): Exported {
  try {
    return (JSON.parse(fs.readFileSync(recordFile(), "utf8")) as { skills?: Exported }).skills ?? {};
  } catch {
    return {};
  }
}

/** Every file of a skill folder (links followed), sorted, relative to the folder. */
function filesOf(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
    if (SKIP.has(name)) continue;
    const r = rel ? `${rel}/${name}` : name;
    const st = fs.statSync(path.join(dir, r));
    if (st.isDirectory()) out.push(...filesOf(dir, r));
    else if (st.isFile()) out.push(r);
  }
  return out;
}

/** Frontmatter with tags written as {name}; the rest of SKILL.md stays as it is. */
function uploadable(text: string): { text: string; fixes: string[]; problems: string[] } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { text, fixes: [], problems: ["SKILL.md has no frontmatter (name, description)"] };
  const fixes: string[] = [];
  const front = m[1]!.replace(/<\/?([A-Za-z][\w.-]*)>/g, (tag, inner: string) => {
    fixes.push(`${tag} → {${inner}} in the description`);
    return `{${inner}}`;
  });
  const problems: string[] = [];
  let meta: { name?: unknown; description?: unknown } = {};
  try {
    meta = (YAML.parse(front) as typeof meta) ?? {};
  } catch {
    problems.push("the frontmatter is not valid YAML");
  }
  const name = typeof meta.name === "string" ? meta.name : undefined;
  if (!name) problems.push("no name in the frontmatter");
  else if (!/^[a-z0-9-]{1,64}$/.test(name)) problems.push(`the name "${name}" may only have lowercase letters, digits and hyphens (64 at most)`);
  const desc = typeof meta.description === "string" ? meta.description.trim() : "";
  if (!desc) problems.push("no description in the frontmatter");
  else if (desc.length > 1024) problems.push(`the description has ${desc.length} characters; the upload takes 1024 at most`);
  return { text: front === m[1] ? text : text.replace(m[1]!, front), fixes, problems };
}

function read(dir: string): { files: Array<[string, Buffer]>; hash: string; fixes: string[]; problems: string[] } {
  const h = crypto.createHash("sha256");
  let fixes: string[] = [];
  let problems: string[] = [];
  const files = filesOf(dir).map((rel): [string, Buffer] => {
    let data = fs.readFileSync(path.join(dir, rel));
    h.update(`${rel}\0${data.length}\0`).update(data);
    if (rel === "SKILL.md") {
      const u = uploadable(data.toString("utf8"));
      ({ fixes, problems } = u);
      data = Buffer.from(u.text, "utf8");
    }
    return [rel, data];
  });
  if (!files.some(([r]) => r === "SKILL.md")) problems.push("no SKILL.md");
  return { files, hash: h.digest("hex"), fixes, problems };
}

/** The skills gctk would zip, and whether each changed since the last zip. */
export function claudeAppSkills(o: { home?: string } = {}): AppSkills {
  const source = path.join(o.home ?? os.homedir(), ".cursor", "skills");
  const record = readRecord();
  const skills: AppSkill[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(source).filter(WANTED).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const dir = path.join(source, name);
    try {
      if (!fs.statSync(dir).isDirectory() || !fs.existsSync(path.join(dir, "SKILL.md"))) continue;
      const r = read(dir);
      const last = record[name];
      skills.push({ name, dir, files: r.files.length, status: !last ? "new" : last.hash === r.hash ? "same" : "changed", ...(last ? { exportedAt: last.at } : {}), fixes: r.fixes, problems: r.problems });
    } catch {
      // unreadable folder: not offered
    }
  }
  return { source, out: appSkillsDir(), skills };
}

/** Makes one zip per skill (the folder at the top, as the upload expects) and records what it zipped. */
export function exportClaudeAppSkills(names: string[], o: { home?: string } = {}): { out: string; written: string[] } {
  const all = claudeAppSkills(o);
  const chosen = all.skills.filter((s) => names.includes(s.name));
  if (!chosen.length) throw new GctkError("INVALID_INPUT", "Choose at least one skill.");
  const unknown = names.filter((n) => !all.skills.some((s) => s.name === n));
  if (unknown.length) throw new GctkError("INVALID_INPUT", `Unknown skill: ${unknown.join(", ")}. Refresh the page.`);
  fs.mkdirSync(all.out, { recursive: true });
  // The folder holds only this export's zips, so the user uploads exactly these.
  for (const f of fs.readdirSync(all.out)) if (f.endsWith(".zip")) fs.rmSync(path.join(all.out, f), { force: true });
  const record = readRecord();
  const at = new Date().toISOString();
  const written: string[] = [];
  for (const s of chosen) {
    const r = read(s.dir);
    const file = path.join(all.out, `${s.name}.zip`);
    fs.writeFileSync(file, zip(r.files.map(([rel, data]) => [`${s.name}/${rel}`, data])));
    record[s.name] = { hash: r.hash, at };
    written.push(file);
  }
  fs.writeFileSync(recordFile(), `${JSON.stringify({ skills: record }, null, 2)}\n`, { mode: 0o600 });
  return { out: all.out, written };
}

// ---------------------------------------------------------------- zip

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A plain zip (deflate, UTF-8 names, no timestamps that differ per run). */
export function zip(entries: Array<[string, Buffer]>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // 2026-01-01, so the same skill gives the same zip
  for (const [name, data] of entries) {
    const n = Buffer.from(name, "utf8");
    const packed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(n.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, n, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(n.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, n);
    offset += head.length + n.length + packed.length;
  }
  const size = central.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
