import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeAppSkills, exportClaudeAppSkills } from "../src/core/claude-skills.js";

let tmp: string;
let home: string;
const saved = { ...process.env };
const skills = () => path.join(home, ".cursor", "skills");
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const skill = (name: string, description = `Use ${name} for things.`, extra: Record<string, string> = {}) => {
  write(path.join(skills(), name, "SKILL.md"), `---\nname: ${name}\ndescription: >-\n  ${description}\n---\n\nBody of ${name} <keep>\n`);
  for (const [rel, text] of Object.entries(extra)) write(path.join(skills(), name, rel), text);
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-claude-skills-"));
  home = path.join(tmp, "home");
  process.env.GCTK_HOME = path.join(tmp, "gctk");
});
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("skills for the Claude app", () => {
  it("offers the AVA skills and the lab facilitator, not other skills", () => {
    skill("ava-build");
    skill("axl-lab-facilitator");
    skill("axl-capsule");
    skill("my-own");
    write(path.join(skills(), "ava-broken", "README.md"), "no SKILL.md");
    expect(claudeAppSkills({ home }).skills.map((s) => s.name)).toEqual(["ava-build", "axl-lab-facilitator"]);
  });

  it("zips each skill with its folder at the top, fixes tags in the frontmatter only, and never changes the source", () => {
    skill("ava-test", "Store them under `.ava-lifecycle/<slug>/` locally.", { "references/a.md": "A", ".DS_Store": "x" });
    const before = fs.readFileSync(path.join(skills(), "ava-test", "SKILL.md"), "utf8");
    const s = claudeAppSkills({ home }).skills[0]!;
    expect(s).toMatchObject({ name: "ava-test", status: "new", files: 2, problems: [] });
    expect(s.fixes).toEqual(["<slug> → {slug} in the description"]);

    const r = exportClaudeAppSkills(["ava-test"], { home });
    const file = path.join(r.out, "ava-test.zip");
    expect(r.written).toEqual([file]);
    expect(execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).trim().split("\n").sort()).toEqual(["ava-test/SKILL.md", "ava-test/references/a.md"]);
    const md = execFileSync("unzip", ["-p", file, "ava-test/SKILL.md"], { encoding: "utf8" });
    expect(md).toContain(".ava-lifecycle/{slug}/");
    expect(md).toContain("Body of ava-test <keep>"); // only the frontmatter changes
    expect(execFileSync("unzip", ["-p", file, "ava-test/references/a.md"], { encoding: "utf8" })).toBe("A");
    expect(fs.readFileSync(path.join(skills(), "ava-test", "SKILL.md"), "utf8")).toBe(before);
  });

  it("shows which skills changed since the last zips, and keeps only the newest zips in the folder", () => {
    skill("ava-build");
    skill("ava-design");
    exportClaudeAppSkills(["ava-build", "ava-design"], { home });
    expect(claudeAppSkills({ home }).skills.map((s) => s.status)).toEqual(["same", "same"]);

    // An AVA harness update rewrites one skill and adds another.
    write(path.join(skills(), "ava-design", "references", "new.md"), "new");
    skill("ava-knowledge");
    expect(Object.fromEntries(claudeAppSkills({ home }).skills.map((s) => [s.name, s.status]))).toEqual({ "ava-build": "same", "ava-design": "changed", "ava-knowledge": "new" });

    const r = exportClaudeAppSkills(["ava-design", "ava-knowledge"], { home });
    expect(fs.readdirSync(r.out).filter((f) => f.endsWith(".zip")).sort()).toEqual(["ava-design.zip", "ava-knowledge.zip"]);
    expect(claudeAppSkills({ home }).skills.every((s) => s.status === "same")).toBe(true);
  });

  it("names what the upload may refuse", () => {
    skill("ava-long", "x".repeat(1100));
    write(path.join(skills(), "ava-Bad", "SKILL.md"), "---\nname: ava-Bad\ndescription: ok\n---\n");
    const by = Object.fromEntries(claudeAppSkills({ home }).skills.map((s) => [s.name, s.problems.join(" ")]));
    expect(by["ava-long"]).toMatch(/1024/);
    expect(by["ava-Bad"]).toMatch(/lowercase/);
    expect(() => exportClaudeAppSkills(["nope"], { home })).toThrow(/at least one/);
  });
});
