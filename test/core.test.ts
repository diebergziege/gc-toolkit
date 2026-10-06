import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listProfiles, loadProfile, resolveProfileName, saveProfile, setActiveProfileName } from "../src/core/profiles.js";
import { resolveRegion } from "../src/core/regions.js";

describe("regions", () => {
  it("resolves region keys and domains", () => {
    expect(resolveRegion("eu-central-1")).toBe("mypurecloud.de");
    expect(resolveRegion("mypurecloud.de")).toBe("mypurecloud.de");
    expect(resolveRegion("https://api.euc1.pure.cloud/")).toBe("euc1.pure.cloud");
    expect(() => resolveRegion("example.com")).toThrow(/Unknown/);
  });
});

describe("profiles", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-test-"));
    process.env.GCTK_HOME = home;
    delete process.env.GCTK_PROFILE;
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.GCTK_HOME;
  });

  it("saves, lists and loads profiles without secrets", () => {
    saveProfile({ name: "prod-de", region: "mypurecloud.de", tier: "production", credentials: "keychain" });
    expect(listProfiles()).toEqual(["prod-de"]);
    const p = loadProfile("prod-de");
    expect(p).toMatchObject({ tier: "production", region: "mypurecloud.de" });
    expect(fs.readFileSync(path.join(home, "profiles", "prod-de.yaml"), "utf8")).not.toMatch(/secret:/i);
  });

  it("still loads profile files written with a policy, and saves them without it", () => {
    fs.mkdirSync(path.join(home, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(home, "profiles", "old.yaml"), "region: mypurecloud.de\ntier: production\npolicy:\n  default: read-only\n  allow: []\n  deny: []\n");
    const p = loadProfile("old");
    expect(p).toEqual({ name: "old", region: "mypurecloud.de", tier: "production", description: undefined, credentials: "keychain" });
    saveProfile(p);
    expect(fs.readFileSync(path.join(home, "profiles", "old.yaml"), "utf8")).not.toMatch(/policy/);
  });

  it("resolves explicit > env > active", () => {
    saveProfile({ name: "a", region: "mypurecloud.de", tier: "dev", credentials: "env" });
    saveProfile({ name: "b", region: "mypurecloud.de", tier: "dev", credentials: "env" });
    expect(() => resolveProfileName()).toThrow(/No Genesys Cloud profile/);
    setActiveProfileName("a");
    expect(resolveProfileName()).toBe("a");
    process.env.GCTK_PROFILE = "b";
    expect(resolveProfileName()).toBe("b");
    expect(resolveProfileName("a")).toBe("a");
  });
});
