import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { axlSkillStatus, installAxlSkillZip, unzip } from "../src/core/axl-skills.js";
import { zip } from "../src/core/claude-skills.js";

let tmp: string;
let home: string;
const saved = { ...process.env };
const skillMd = (name: string) => Buffer.from(`---\nname: ${name}\ndescription: Does ${name}.\n---\n\nBody`);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-axl-skills-"));
  home = path.join(tmp, "home");
  process.env.GCTK_HOME = path.join(tmp, "gctk");
});
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("AXL skills", () => {
  it("installs a skill zip into ~/.cursor/skills and keeps the one it replaces", () => {
    expect(axlSkillStatus(undefined, home).map((s) => s.path)).toEqual([undefined, undefined]);
    const z = zip([["axl-capsule/SKILL.md", skillMd("axl-capsule")], ["axl-capsule/scripts/capsule.mjs", Buffer.from("export {}")], ["__MACOSX/axl-capsule/._x", Buffer.from("junk")]]);
    expect(installAxlSkillZip(z, home)).toEqual({ installed: ["axl-capsule"], backups: [] });
    const dir = path.join(home, ".cursor", "skills", "axl-capsule");
    expect(fs.readdirSync(dir).sort()).toEqual(["SKILL.md", "scripts"]);
    expect(axlSkillStatus(undefined, home)).toMatchObject([{ name: "axl-lab-facilitator" }, { name: "axl-capsule", path: dir }]);

    fs.writeFileSync(path.join(dir, "mine.md"), "kept");
    const again = installAxlSkillZip(z, home);
    expect(again.backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(again.backups[0]!, "mine.md"), "utf8")).toBe("kept");
    expect(fs.existsSync(path.join(dir, "mine.md"))).toBe(false);
    expect(fs.readdirSync(path.join(home, ".cursor", "skills")).filter((n) => n.startsWith("."))).toEqual([]);
  });

  it("finds a skill in the workshop folder too", () => {
    const folder = path.join(tmp, "ws");
    fs.mkdirSync(path.join(folder, ".cursor", "skills", "axl-lab-facilitator"), { recursive: true });
    fs.writeFileSync(path.join(folder, ".cursor", "skills", "axl-lab-facilitator", "SKILL.md"), skillMd("axl-lab-facilitator"));
    expect(axlSkillStatus(folder, home)[0]!.path).toBe(path.join(folder, ".cursor", "skills", "axl-lab-facilitator"));
  });

  it("refuses other skills, paths outside the folder and files that are no zip", () => {
    expect(() => installAxlSkillZip(zip([["other/SKILL.md", skillMd("other")]]), home)).toThrow(/holds the skill other/);
    expect(() => installAxlSkillZip(zip([["readme.txt", Buffer.from("x")]]), home)).toThrow(/no skill/);
    expect(() => unzip(zip([["../evil.sh", Buffer.from("x")]]))).toThrow(/outside its folder/);
    expect(() => unzip(Buffer.from("not a zip at all, just some text here"))).toThrow(/not a zip/);
    expect(fs.existsSync(path.join(home, ".cursor", "skills"))).toBe(false);
  });
});
