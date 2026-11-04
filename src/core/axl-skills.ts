import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { GctkError } from "./errors.js";
import { gctkHome } from "./paths.js";

/**
 * An AXL workshop needs two Cursor skills next to the AVA harness: axl-lab-facilitator runs the lab,
 * axl-capsule hands it over to the customer at the end. They are shared as zip files (one skill
 * each, the skill folder at the top); gctk installs them into ~/.cursor/skills, where Cursor finds
 * them in every folder. A workshop folder's own .cursor/skills counts as well.
 */
export const AXL_SKILLS = [
  { name: "axl-lab-facilitator", title: "AXL lab facilitator", what: "runs the lab: research, discovery, build and test, readout" },
  { name: "axl-capsule", title: "AXL capsule", what: "packs the finished workshop so the customer can continue it" },
] as const;

export interface AxlSkillStatus {
  name: string;
  title: string;
  what: string;
  /** The skill folder Cursor loads, if any. */
  path?: string;
  /** It is a link to another folder (gctk does not replace it). */
  link?: boolean;
}

const userSkillsDir = (home = os.homedir()) => path.join(home, ".cursor", "skills");

function skillName(skillMd: string): string | undefined {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  return fm ? /^name:\s*["']?([\w.-]+)["']?\s*$/m.exec(fm[1]!)?.[1] : undefined;
}

export function axlSkillStatus(folder?: string, home = os.homedir()): AxlSkillStatus[] {
  const dirs = [...(folder ? [path.join(folder, ".cursor", "skills")] : []), userSkillsDir(home)];
  return AXL_SKILLS.map((s) => {
    for (const d of dirs) {
      const dir = path.join(d, s.name);
      try {
        if (skillName(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")) === s.name) return { ...s, path: dir, ...(fs.lstatSync(dir).isSymbolicLink() ? { link: true } : {}) };
      } catch {
        // not in this folder
      }
    }
    return { ...s };
  });
}

// ------------------------------------------------------------------ unzip

const MAX_FILES = 5000;
const MAX_TOTAL = 200 * 1024 * 1024;

/** Files of a zip (stored or deflated). Refuses links, absolute paths and "..", so nothing lands outside the skill folder. */
export function unzip(buf: Buffer): Array<[string, Buffer]> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new GctkError("INVALID_INPUT", "This is not a zip file.");
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_FILES) throw new GctkError("INVALID_INPUT", "The zip has too many files for a skill.");
  let p = buf.readUInt32LE(eocd + 16);
  const out: Array<[string, Buffer]> = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new GctkError("INVALID_INPUT", "The zip file is damaged.");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const mode = buf.readUInt32LE(p + 38) >>> 16;
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    if (name.startsWith("__MACOSX/") || path.posix.basename(name) === ".DS_Store") continue;
    if (madeBy === 3 && (mode & 0o170000) === 0o120000) throw new GctkError("INVALID_INPUT", `The zip holds a link (${name}); gctk installs only plain files.`);
    if (name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes("..")) throw new GctkError("INVALID_INPUT", `The zip holds a path outside its folder (${name}).`);
    total += size;
    if (total > MAX_TOTAL) throw new GctkError("INVALID_INPUT", "The zip unpacks to more than 200 MB, too much for a skill.");
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new GctkError("INVALID_INPUT", "The zip file is damaged.");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) }) : undefined;
    if (!data || data.length !== size) throw new GctkError("INVALID_INPUT", `gctk cannot unpack ${name} (packed in a way it does not know).`);
    out.push([name, data]);
  }
  return out;
}

// --------------------------------------------------------------- install

/**
 * Installs the AXL skills in a zip into ~/.cursor/skills. A skill already there moves to the gctk
 * home (skill-backups/) first, so nothing the user had is lost.
 */
export function installAxlSkillZip(buf: Buffer, home = os.homedir()): { installed: string[]; backups: string[] } {
  const files = unzip(buf);
  const roots = new Map<string, string>();
  for (const [name, data] of files) {
    const parts = name.split("/");
    if (parts.at(-1) !== "SKILL.md" || parts.length > 2) continue;
    const skill = skillName(data.toString("utf8"));
    if (skill) roots.set(skill, parts.length === 2 ? `${parts[0]}/` : "");
  }
  const known = [...roots.keys()].filter((n) => AXL_SKILLS.some((s) => s.name === n));
  if (!known.length) {
    throw new GctkError("INVALID_INPUT", roots.size
      ? `This zip holds the skill ${[...roots.keys()].join(", ")}, not ${AXL_SKILLS.map((s) => s.name).join(" or ")}.`
      : "This zip holds no skill (no SKILL.md at the top or in its one folder).");
  }
  const dir = userSkillsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const installed: string[] = [];
  const backups: string[] = [];
  for (const skill of known) {
    const prefix = roots.get(skill)!;
    const target = path.join(dir, skill);
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
      throw new GctkError("INVALID_INPUT", `${target} is a link to another folder; update the skill there.`);
    }
    const tmp = path.join(dir, `.gctk-${skill}-${crypto.randomBytes(4).toString("hex")}`);
    try {
      for (const [name, data] of files) {
        if (!name.startsWith(prefix) || (!prefix && name.split("/")[0] === "__MACOSX")) continue;
        const file = path.join(tmp, name.slice(prefix.length));
        if (!file.startsWith(tmp + path.sep)) continue;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, data, { mode: /\.(m?js|sh|py)$/.test(file) ? 0o755 : 0o644 });
      }
      if (fs.existsSync(target)) {
        const backup = path.join(gctkHome(), "skill-backups", `${skill}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.cpSync(target, backup, { recursive: true });
        fs.rmSync(target, { recursive: true, force: true });
        backups.push(backup);
      }
      fs.renameSync(tmp, target);
      installed.push(skill);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return { installed, backups };
}
