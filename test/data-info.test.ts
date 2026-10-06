import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataInfo, dataPath } from "../src/core/data-info.js";
import { saveProfile } from "../src/core/profiles.js";

let home: string;
const saved = { ...process.env };
const noKeychain = { has: () => false };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-data-"));
  process.env.GCTK_HOME = home;
});
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(home, { recursive: true, force: true });
});

describe("your data", () => {
  it("lists gctk's folder with sizes, the keychain entries by name and what it wrote elsewhere", () => {
    saveProfile({ name: "demo-org", region: "mypurecloud.de", tier: "sandbox", credentials: "keychain" });
    fs.writeFileSync(path.join(home, "mcp-launch.json"), JSON.stringify({ records: { a: { account: "__mcp__abc", server: "ava-harness", file: path.join(home, "x.json") }, b: { account: "__mcp__abc", server: "ava-harness", file: path.join(home, "y.json") } } }));
    const d = dataInfo(noKeychain);
    expect(d.home).toBe(home);
    expect(d.homeFromEnv).toBe(true);
    expect(d.places.find((p) => p.key === "profiles")).toMatchObject({ exists: true, items: 1, label: "Orgs" });
    expect(d.places.find((p) => p.key === "demos")).toMatchObject({ exists: false, bytes: 0 });
    expect(d.secrets.map((s) => s.account)).toEqual(["demo-org", "__mcp__abc", "__approval-key__", expect.stringMatching(/^__ui-token__/)]);
    expect(d.secrets[1]!.what).toBe("Secret of ava-harness (AI setup, 2 entries in editor configs)");
    expect(d.elsewhere.map((e) => e.path)).toEqual([path.join(home, "x.json"), path.join(home, "y.json")]);
  });

  it("opens only places it lists", () => {
    saveProfile({ name: "demo-org", region: "mypurecloud.de", tier: "sandbox", credentials: "env" });
    expect(dataPath("home", noKeychain)).toBe(home);
    expect(dataPath("profiles", noKeychain)).toBe(path.join(home, "profiles"));
    expect(dataPath("demos", noKeychain)).toBeUndefined();
    expect(dataPath("/etc/passwd", noKeychain)).toBeUndefined();
  });
});
