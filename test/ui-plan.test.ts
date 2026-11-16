import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appDir, appGctkJs, appVersion } from "../src/core/install.js";
import { uiPlan } from "../src/ui/daemon.js";

describe("which gctk runs the shared UI", () => {
  it("reuses the same build, and never replaces a newer UI with an older gctk", () => {
    expect(uiPlan({ build: "0.45.0+abc", running: { version: "0.45.0+abc", port: 4285 }, keptPort: 4285 })).toBe("reuse");
    // An editor's plugin that has not updated yet keeps the newer UI the top bar installed.
    expect(uiPlan({ build: "0.44.0+old", running: { version: "0.45.0+new", port: 4285 }, keptPort: 4285 })).toBe("reuse");
    // A newer gctk, or another build of the same version, takes the UI over.
    expect(uiPlan({ build: "0.46.0+x", running: { version: "0.45.0+new", port: 4285 }, keptPort: 4285 })).toBe("start-self");
    expect(uiPlan({ build: "0.45.0+rebuilt", running: { version: "0.45.0+abc", port: 4285 }, keptPort: 4285 })).toBe("start-self");
    // gctk ui --restart replaces it in any case; another kept port starts it there.
    expect(uiPlan({ build: "0.45.0+abc", running: { version: "0.45.0+abc", port: 4285 }, keptPort: 4285, restart: true })).toBe("start-self");
    expect(uiPlan({ build: "0.45.0+abc", running: { version: "0.45.0+abc", port: 4285 }, keptPort: 4300 })).toBe("start-self");
  });

  it("starts the installed copy when it is newer than the gctk asking, a development run always itself", () => {
    expect(uiPlan({ build: "0.44.0+old", installed: "0.45.0" })).toBe("start-installed");
    expect(uiPlan({ build: "0.45.0+abc", installed: "0.45.0" })).toBe("start-self");
    expect(uiPlan({ build: "0.46.0+abc", installed: "0.45.0" })).toBe("start-self");
    expect(uiPlan({ build: "dev+dev", installed: "0.45.0" })).toBe("start-self");
    expect(uiPlan({ build: "dev+dev", running: { version: "0.45.0+abc", port: 4285 }, keptPort: 4285 })).toBe("start-self");
  });
});

describe("the installed copy's version", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-app-"));
    process.env.GCTK_HOME = home;
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.GCTK_HOME;
  });

  it("comes from app/package.json, and only when gctk.js is there", () => {
    expect(appVersion()).toBeUndefined();
    fs.mkdirSync(path.dirname(appGctkJs()), { recursive: true });
    fs.writeFileSync(path.join(appDir(), "package.json"), JSON.stringify({ version: "0.45.0" }));
    expect(appVersion()).toBeUndefined();
    fs.writeFileSync(appGctkJs(), "#!/usr/bin/env node\n");
    expect(appVersion()).toBe("0.45.0");
  });
});
