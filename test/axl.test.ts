import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TokenProvider } from "../src/core/auth.js";
import {
  axlStatus,
  formatAxlStatus,
  harnessEnv,
  lastHarnessStart,
  recordHarnessStart,
  listAxlSessions,
  loadAxlSettings,
  projectToolSpec,
  removeWorkshop,
  sageRoute,
  saveHarnessCommand,
  saveWorkshop,
  setupWorkshopFolder,
  workshopFolderStatus,
  workshopMcpFile,
} from "../src/core/axl.js";
import { GenesysClient } from "../src/core/client.js";
import { saveProfile, type Profile, type Tier } from "../src/core/profiles.js";

let home: string;
let tmp: string;
const saved = { ...process.env };

function profile(name: string, tier: Tier, region = "mypurecloud.de"): Profile {
  const p: Profile = { name, region, tier, credentials: "env" };
  saveProfile(p);
  return p;
}
const fakeGctk = () => {
  const js = path.join(tmp, "dist", "gctk.js");
  fs.mkdirSync(path.dirname(js), { recursive: true });
  fs.writeFileSync(js, "");
  return js;
};
const harness = () => {
  const cmd = path.join(tmp, "ava-mcp");
  fs.writeFileSync(cmd, "");
  saveHarnessCommand(cmd);
  return cmd;
};
const noGlobal = () => path.join(tmp, "no-global-mcp.json");

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-axl-"));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-axl-ws-"));
  process.env.GCTK_HOME = home;
  process.env.GCTK_CLIENT_ID = "client-id";
  process.env.GCTK_CLIENT_SECRET = "client-secret";
});
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("AXL workshops", () => {
  it("offers and accepts only sandbox and dev orgs in regions the harness knows", () => {
    profile("sandbox-org", "sandbox");
    profile("dev-org", "dev", "euw2.pure.cloud");
    profile("prod-de", "production");
    profile("odd", "sandbox", "inintca.com");
    expect(axlStatus(noGlobal()).choices.map((c) => c.name).sort()).toEqual(["dev-org", "sandbox-org"]);
    expect(() => saveWorkshop({ name: "Acme", profile: "prod-de" })).toThrow(/only run on sandbox or dev/);
    expect(() => saveWorkshop({ name: "Acme", profile: "odd" })).toThrow(/does not know the region/);
    const w = saveWorkshop({ name: "Acme Bank", profile: "dev-org" });
    expect(w).toMatchObject({ id: "acme-bank", name: "Acme Bank", profile: "dev-org" });
    expect(axlStatus(noGlobal()).workshops[0]!.org).toMatchObject({ profile: "dev-org", habitat: "prod-euw2", credentialsStored: true });
  });

  it("keeps several workshops, each with its own org and folder", () => {
    profile("sandbox-org", "sandbox");
    profile("dev-org", "dev", "euw2.pure.cloud");
    const a = saveWorkshop({ name: "Acme", profile: "sandbox-org", folder: path.join(tmp, "acme") });
    const b = saveWorkshop({ name: "Acme", profile: "dev-org", folder: path.join(tmp, "acme-2") });
    expect([a.id, b.id]).toEqual(["acme", "acme-2"]);
    expect(() => saveWorkshop({ name: "Other", folder: path.join(tmp, "acme") })).toThrow(/already uses this folder/);
    expect(() => saveWorkshop({ id: b.id, folder: "relative" })).toThrow(/absolute/);
    saveWorkshop({ id: b.id, name: "Acme follow-up" });
    expect(loadAxlSettings().workshops.map((w) => [w.id, w.name, w.profile])).toEqual([["acme", "Acme", "sandbox-org"], ["acme-2", "Acme follow-up", "dev-org"]]);
    expect(() => saveWorkshop({})).toThrow(/Give the workshop a name/);
  });

  it("keeps the prompt brief per workshop, only known fields in their ranges", () => {
    const w = saveWorkshop({ name: "Oktoberfest" });
    saveWorkshop({ id: w.id, brief: { useCase: "  Reservierungen  ", persona: "Johann", language: "de", threshold: 150, parallel: 0, afterThreshold: "decide", functionPath: true, evil: "<script>" } });
    expect(loadAxlSettings().workshops[0]!.brief).toEqual({ useCase: "Reservierungen", persona: "Johann", language: "de", threshold: 100, parallel: 1, afterThreshold: "decide", functionPath: true });
    saveWorkshop({ id: w.id, brief: {} });
    expect(loadAxlSettings().workshops[0]!.brief).toBeUndefined();
  });

  it("takes over the single workshop of 0.20.x", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "axl.json"), JSON.stringify({ profile: "lab", workshopDir: path.join(tmp, "qbr_test_session") }));
    expect(loadAxlSettings().workshops).toEqual([{ id: "qbr-test-session", name: "qbr_test_session", profile: "lab", folder: path.join(tmp, "qbr_test_session"), created: new Date(0).toISOString() }]);
  });
});

describe("workshop folder", () => {
  it("writes the harness server into the folder's own .cursor/mcp.json, keeps the user's entries, never a secret", () => {
    const dir = path.join(tmp, "ws");
    fs.mkdirSync(path.join(dir, ".cursor"), { recursive: true });
    fs.writeFileSync(workshopMcpFile(dir), JSON.stringify({ mcpServers: {
      other: { command: "x" },
      "ava-harness": { command: "/old/ava-mcp", args: ["serve"], env: { FASTMCP_LOG_LEVEL: "ERROR", AVA_USE_INTERNAL_SAGE: "true", AVA_HABITAT: "prod-euc1", GENESYS_CLIENT_ID: "id", GENESYS_CLIENT_SECRET: "s3cret" }, timeout: 60000 },
    } }));
    profile("lab", "sandbox");
    const w = saveWorkshop({ name: "Lab", profile: "lab", folder: dir });
    const gctkJs = fakeGctk();

    expect(setupWorkshopFolder(w.id, gctkJs, process.execPath)).toBe(true);
    const text = fs.readFileSync(workshopMcpFile(dir), "utf8");
    expect(text).not.toMatch(/s3cret|GENESYS_CLIENT|AVA_HABITAT/);
    const mcp = JSON.parse(text);
    expect(mcp.mcpServers.other).toEqual({ command: "x" });
    expect(mcp.mcpServers["ava-harness"]).toEqual({ command: process.execPath, args: [gctkJs, "axl-harness", "--workshop", "lab", "--org", "lab"], env: { FASTMCP_LOG_LEVEL: "ERROR", AVA_USE_INTERNAL_SAGE: "true" }, timeout: 60000 });
    expect(fs.existsSync(path.join(dir, "axl-sessions"))).toBe(true);
    expect(workshopFolderStatus(w)).toEqual({ exists: true, connected: true, org: "lab", stale: false });
    expect(setupWorkshopFolder(w.id, gctkJs, process.execPath)).toBe(false);

    // Another org for the workshop: out of date until written again.
    profile("lab2", "dev");
    const w2 = saveWorkshop({ id: w.id, profile: "lab2" });
    expect(workshopFolderStatus(w2)).toMatchObject({ org: "lab", stale: true });
    expect(setupWorkshopFolder(w.id, gctkJs, process.execPath)).toBe(true);
    expect(workshopFolderStatus(w2)).toMatchObject({ org: "lab2", stale: false });

    fs.rmSync(gctkJs);
    expect(workshopFolderStatus(w2).stale).toBe(true);

    // Removing the workshop takes out only its own server; the folder and the rest stay.
    expect(removeWorkshop(w.id)).toEqual({ removedServer: true });
    expect(JSON.parse(fs.readFileSync(workshopMcpFile(dir), "utf8")).mcpServers).toEqual({ other: { command: "x" } });
    expect(fs.existsSync(path.join(dir, "axl-sessions"))).toBe(true);
    expect(loadAxlSettings().workshops).toEqual([]);
  });

  it("does not touch anything without a folder and an allowed org", () => {
    const w = saveWorkshop({ name: "Lab" });
    expect(() => setupWorkshopFolder(w.id, "/x/dist/gctk.js")).toThrow(/the folder first/);
    saveWorkshop({ id: w.id, folder: path.join(tmp, "ws") });
    expect(() => setupWorkshopFolder(w.id, "/x/dist/gctk.js")).toThrow(/the org first/);
    profile("lab", "sandbox");
    saveWorkshop({ id: w.id, profile: "lab" });
    profile("lab", "production");
    expect(() => setupWorkshopFolder(w.id, "/x/dist/gctk.js")).toThrow(/only run on sandbox or dev/);
    expect(fs.existsSync(path.join(tmp, "ws"))).toBe(false);
  });

  it("lists sessions with the furthest job reached", () => {
    const s = path.join(tmp, "axl-sessions");
    for (const [name, files] of [["AXL-acme-bank", ["spec-artifact.md", "run-artifact.html"]], ["AXL-chipotle", ["pov-deck.html"]], ["AXL-new", []], ["notes", ["x.md"]]] as const) {
      fs.mkdirSync(path.join(s, name), { recursive: true });
      for (const f of files) fs.writeFileSync(path.join(s, name, f), "");
    }
    const byName = Object.fromEntries(listAxlSessions(s).map((x) => [x.name, x]));
    expect(Object.keys(byName).sort()).toEqual(["AXL-acme-bank", "AXL-chipotle", "AXL-new"]);
    expect(byName["AXL-acme-bank"]).toMatchObject({ stage: "build", artifacts: ["spec", "run"] });
    expect(byName["AXL-chipotle"]).toMatchObject({ stage: "research", artifacts: ["pov"] });
    expect(byName["AXL-new"]).toMatchObject({ stage: "new", artifacts: [] });
  });
});

describe("harness launcher", () => {
  it("passes the workshop's org credentials and habitat, never gctk's own secrets", () => {
    profile("sandbox-org", "sandbox");
    const cmd = harness();
    saveWorkshop({ name: "Lab", profile: "sandbox-org" });
    const { env, command, workshop } = harnessEnv({ PATH: "/usr/bin", FASTMCP_LOG_LEVEL: "ERROR", GCTK_APPROVAL_KEY: "k", GCTK_UI_TOKEN: "t" }, { workshop: "lab", org: "sandbox-org" });
    expect(command).toBe(cmd);
    expect(workshop.id).toBe("lab");
    expect(env).toMatchObject({ GENESYS_CLIENT_ID: "client-id", GENESYS_CLIENT_SECRET: "client-secret", AVA_HABITAT: "prod-euc1", FASTMCP_LOG_LEVEL: "ERROR" });
    expect(env.GCTK_APPROVAL_KEY).toBeUndefined();
    expect(env.GCTK_UI_TOKEN).toBeUndefined();
  });

  it("each workshop folder gets its own org", () => {
    profile("sandbox-org", "sandbox");
    profile("dev-org", "dev", "euw2.pure.cloud");
    harness();
    saveWorkshop({ name: "A", profile: "sandbox-org" });
    saveWorkshop({ name: "B", profile: "dev-org" });
    expect(harnessEnv({}, { workshop: "a", org: "sandbox-org" }).env.AVA_HABITAT).toBe("prod-euc1");
    expect(harnessEnv({}, { workshop: "b", org: "dev-org" }).env.AVA_HABITAT).toBe("prod-euw2");
  });

  it("refuses a workshop or org the page does not have (the folder's file is editable)", () => {
    profile("lab", "sandbox");
    profile("other", "sandbox");
    harness();
    saveWorkshop({ name: "Lab", profile: "lab" });
    expect(() => harnessEnv({}, { workshop: "lab", org: "other" })).toThrow(/has "lab" on the AXL page/);
    expect(() => harnessEnv({}, { workshop: "nope", org: "lab" })).toThrow(/No AXL workshop "nope"/);
  });

  it("still starts folders set up by 0.20.x (org only) when exactly one workshop has that org", () => {
    profile("lab", "sandbox");
    harness();
    saveWorkshop({ name: "One", profile: "lab" });
    expect(harnessEnv({}, { org: "lab" }).workshop.id).toBe("one");
    saveWorkshop({ name: "Two", profile: "lab" });
    expect(() => harnessEnv({}, { org: "lab" })).toThrow(/does not name its AXL workshop/);
  });

  it("checks the tier again at every start", () => {
    profile("lab", "sandbox");
    harness();
    saveWorkshop({ name: "Lab", profile: "lab" });
    profile("lab", "production");
    expect(() => harnessEnv({}, { workshop: "lab", org: "lab" })).toThrow(/only run on sandbox or dev/);
  });

  it("needs an org and an existing harness", () => {
    saveWorkshop({ name: "Lab" });
    expect(() => harnessEnv({}, { workshop: "lab" })).toThrow(/has no org/);
    profile("lab", "dev");
    saveWorkshop({ id: "lab", profile: "lab" });
    saveHarnessCommand(path.join(tmp, "missing"));
    expect(() => harnessEnv({}, { workshop: "lab" })).toThrow(/not found/);
  });

  it("tells the lab its workshop's org by folder, or lists the workshops", () => {
    profile("lab", "sandbox");
    const dir = path.join(tmp, "ws");
    saveWorkshop({ name: "Lab", profile: "lab", folder: dir });
    const st = axlStatus(noGlobal());
    const text = formatAxlStatus(st, path.join(dir, "axl-sessions"));
    expect(text).toMatch(/Workshop "Lab" \(id lab\)/);
    expect(text).toMatch(/Org for the AVA harness: lab \(sandbox, mypurecloud\.de, habitat prod-euc1\)/);
    expect(text).toContain(`sessions in ${path.join(dir, "axl-sessions")}`);
    expect(formatAxlStatus(st, "/elsewhere")).toMatch(/No project uses \/elsewhere/);
    expect(formatAxlStatus(st)).toMatch(/- Lab \(id lab, AXL workshop\): lab/);
  });
});

describe("in Cursor", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  function client(answers: Record<string, number>): { c: GenesysClient; calls: string[] } {
    const p = profile("lab", "sandbox");
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname.startsWith("login.")) return json({ access_token: "t", expires_in: 3600 });
      calls.push(url.pathname);
      const status = answers[url.pathname];
      if (status === undefined) throw new TypeError("fetch failed");
      return json(status === 200 ? { entities: [] } : { message: "no" }, status);
    }) as typeof fetch;
    return { c: new GenesysClient(p, { source: "cli", fetchImpl, tokens: new TokenProvider(p.region, () => ({ clientId: "a", clientSecret: "b" }), fetchImpl) }), calls };
  }

  it("finds which AI agent API the org's client may use", async () => {
    expect(await sageRoute(client({ "/api/v2/agentic/virtualagents": 200 }).c)).toBe("public");
    const internal = client({ "/api/v2/agentic/virtualagents": 403, "/api/v2/apps/agentic/virtualagents": 200 });
    expect(await sageRoute(internal.c)).toBe("internal");
    expect(internal.calls).toEqual(["/api/v2/agentic/virtualagents", "/api/v2/apps/agentic/virtualagents"]);
    expect(await sageRoute(client({ "/api/v2/agentic/virtualagents": 403, "/api/v2/apps/agentic/virtualagents": 403 }).c)).toBeUndefined();
    const down = client({});
    expect(await sageRoute(down.c)).toBeUndefined();
    expect(down.calls).toEqual(["/api/v2/agentic/virtualagents"]);
  });

  it("shows each workshop's last harness start, and whether it ran since the setup", () => {
    const p = profile("lab", "sandbox");
    const dir = path.join(tmp, "ws");
    const a = saveWorkshop({ name: "A", profile: "lab", folder: dir });
    const b = saveWorkshop({ name: "B", profile: "lab" });
    expect(lastHarnessStart(a)).toBeUndefined();
    recordHarnessStart("a", p.name, "prod-euc1, public AI agent API");
    expect(lastHarnessStart(a)).toMatchObject({ profile: "lab", detail: "prod-euc1, public AI agent API", sinceSetup: true });
    expect(lastHarnessStart(b)).toBeUndefined();
    fs.mkdirSync(path.dirname(workshopMcpFile(dir)), { recursive: true });
    fs.writeFileSync(workshopMcpFile(dir), "{}");
    fs.utimesSync(workshopMcpFile(dir), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    expect(lastHarnessStart(a)!.sinceSetup).toBe(false);
  });

  it("notices a global ava-harness without reading its values", () => {
    const file = path.join(tmp, ".cursor", "mcp.json");
    expect(axlStatus(file).globalHarness).toEqual({ present: false, inlineSecret: false });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { "ava-harness": { command: "ava-mcp", env: { GENESYS_CLIENT_SECRET: "s3cret" } } } }));
    const st = axlStatus(file);
    expect(st.globalHarness).toEqual({ present: true, inlineSecret: true });
    expect(JSON.stringify(st)).not.toContain("s3cret");
  });
});

describe("projects (folders that are not AXL workshops)", () => {
  const tool = (cmd: string) => ({ name: "genesys-cloud-architect-mcp", command: cmd, args: ["--stdio"], env: { LOG_LEVEL: "info", GENESYS_CLIENT_SECRET: "never" }, keys: { clientId: "GENESYS_CLIENT_ID", secret: "GENESYS_CLIENT_SECRET", region: "GENESYS_REGION" } });

  it("takes any org, a production org only when confirmed for exactly that org", () => {
    profile("sbx", "sandbox");
    profile("prod-de", "production");
    profile("prod-ie", "production", "mypurecloud.ie");
    expect(() => saveWorkshop({ name: "Acme", profile: "prod-de", lab: false })).toThrow(/production org/);
    const w = saveWorkshop({ name: "Acme", profile: "prod-de", lab: false, confirmProduction: true });
    expect(w).toMatchObject({ lab: false, profile: "prod-de", productionConfirmed: "prod-de" });
    // The confirmation is for that org only.
    expect(() => saveWorkshop({ id: w.id, profile: "prod-ie" })).toThrow(/production org/);
    expect(saveWorkshop({ id: w.id, profile: "sbx" }).productionConfirmed).toBeUndefined();
    // A workshop stays sandbox or dev.
    expect(() => saveWorkshop({ name: "Lab", profile: "prod-de", confirmProduction: true })).toThrow(/only run on sandbox or dev/);
  });

  it("writes the chosen tools into the folder, started through gctk with the project's org, and removes them again", () => {
    profile("sbx", "sandbox");
    const js = fakeGctk();
    const cmd = path.join(tmp, "architect-mcp");
    fs.writeFileSync(cmd, "");
    const folder = path.join(tmp, "acme");
    const w = saveWorkshop({ name: "Acme", profile: "sbx", folder, lab: false, tools: [tool(cmd)] });
    expect(loadAxlSettings().workshops[0]!.tools![0]!.env).toEqual({ LOG_LEVEL: "info" });
    expect(workshopFolderStatus(w)).toMatchObject({ exists: false });
    expect(setupWorkshopFolder(w.id, js)).toBe(true);
    const file = workshopMcpFile(folder);
    const mcp = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(mcp.mcpServers).toEqual({ "genesys-cloud-architect-mcp": { command: process.execPath, args: [js, "project-tool", "--project", w.id, "--tool", "genesys-cloud-architect-mcp"] } });
    expect(fs.existsSync(path.join(folder, "axl-sessions"))).toBe(false);
    expect(workshopFolderStatus(loadAxlSettings().workshops[0]!)).toMatchObject({ stale: false, tools: [{ name: "genesys-cloud-architect-mcp", connected: true }] });
    expect(setupWorkshopFolder(w.id, js)).toBe(false);

    // The AVA harness on, the tool off: the folder follows.
    harness();
    saveWorkshop({ id: w.id, harness: true, tools: [] });
    expect(workshopFolderStatus(loadAxlSettings().workshops[0]!).stale).toBe(true);
    setupWorkshopFolder(w.id, js);
    expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers)).toEqual(["ava-harness"]);
    expect(harnessEnv(process.env, { workshop: w.id, org: "sbx" }).env).toMatchObject({ GENESYS_CLIENT_ID: "client-id", AVA_HABITAT: "prod-euc1" });
    expect(removeWorkshop(w.id)).toEqual({ removedServer: true });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers).toEqual({});
  });

  it("never replaces a server of the same name the user wrote into the folder", () => {
    profile("sbx", "sandbox");
    const js = fakeGctk();
    const cmd = path.join(tmp, "architect-mcp");
    fs.writeFileSync(cmd, "");
    const folder = path.join(tmp, "acme");
    fs.mkdirSync(path.join(folder, ".cursor"), { recursive: true });
    fs.writeFileSync(workshopMcpFile(folder), JSON.stringify({ mcpServers: { "genesys-cloud-architect-mcp": { command: "mine" } } }));
    const w = saveWorkshop({ name: "Acme", profile: "sbx", folder, lab: false, tools: [tool(cmd)] });
    expect(() => setupWorkshopFolder(w.id, js)).toThrow(/already has its own/);
  });

  it("starts a tool with the project's org in the variables it names, from what gctk stored, not from the folder", () => {
    profile("sbx", "sandbox", "euw2.pure.cloud");
    const cmd = path.join(tmp, "architect-mcp");
    fs.writeFileSync(cmd, "");
    const w = saveWorkshop({ name: "Acme", profile: "sbx", lab: false, tools: [tool(cmd)] });
    const spec = projectToolSpec({ project: w.id, tool: "genesys-cloud-architect-mcp" }, { PATH: "/bin", GCTK_UI_TOKEN: "x" });
    expect(spec.command).toBe(cmd);
    expect(spec.args).toEqual(["--stdio"]);
    expect(spec.env).toMatchObject({ PATH: "/bin", LOG_LEVEL: "info", GENESYS_CLIENT_ID: "client-id", GENESYS_CLIENT_SECRET: "client-secret", GENESYS_REGION: "euw2.pure.cloud" });
    expect(spec.env.GCTK_UI_TOKEN).toBeUndefined();
    expect(() => projectToolSpec({ project: w.id, tool: "something-else" })).toThrow(/has no tool/);
    expect(() => projectToolSpec({ project: "nope", tool: "genesys-cloud-architect-mcp" })).toThrow();
    // A production org needs its confirmation at every start.
    profile("sbx", "production", "euw2.pure.cloud");
    expect(() => projectToolSpec({ project: w.id, tool: "genesys-cloud-architect-mcp" })).toThrow(/production org/);
  });
});
