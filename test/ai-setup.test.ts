import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addLocation,
  cleanEnv,
  configFiles,
  formatAiSetup,
  launchSpec,
  moveToKeychain,
  parseJsonc,
  removeLocation,
  removeServer,
  repairServer,
  restoreToFile,
  scanAiSetup,
  setCredentials,
  toolTemplates,
  updateSecret,
  type ScanOptions,
  type SecretStore,
} from "../src/core/ai-setup.js";
import { saveProfile } from "../src/core/profiles.js";
import { ensureStableGctk, olderVersion, stableGctkJs } from "../src/core/stable-gctk.js";

let tmp: string;
let home: string;
let project: string;
let mem: Map<string, string>;
let store: SecretStore;
let opts: ScanOptions;
const saved = { ...process.env };
const SECRET = "s3cr3t-value-abcd-1234";
const CLIENT = "485c8ae1-1111-2222-3333-444455556666";

const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
};
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const harness = (cmd: string) => ({ command: cmd, args: ["serve"], env: { GENESYS_CLIENT_ID: CLIENT, GENESYS_CLIENT_SECRET: SECRET, AVA_HABITAT: "prod-euc1", FASTMCP_LOG_LEVEL: "ERROR" } });
const skill = (dir: string, name: string, description = `Use ${name} for things.`) => write(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody`);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-ai-setup-"));
  home = path.join(tmp, "home");
  project = path.join(tmp, "proj");
  fs.mkdirSync(project, { recursive: true });
  process.env.GCTK_HOME = path.join(tmp, "gctk");
  process.env.GCTK_APPROVAL_KEY = "test-approval-key";
  mem = new Map();
  store = { get: (a) => mem.get(a), set: (a, v) => void mem.set(a, v), remove: (a) => void mem.delete(a) };
  opts = { home, platform: "linux", store, clients: () => new Map([[CLIENT, "sandbox-org"]]) };
  // A folder Cursor knows, with its own .cursor/mcp.json (the second config file of many tests).
  addLocation(project, home);
});
const folderFile = () => path.join(project, ".cursor", "mcp.json");
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** An executable the fixes can resolve (the command must exist on this computer). */
function fakeCommand(): string {
  const cmd = path.join(tmp, "bin", "ava-mcp");
  write(cmd, "#!/bin/sh\n");
  fs.chmodSync(cmd, 0o755);
  return cmd;
}

describe("discovery", () => {
  it("finds only Cursor's files: the global one, known folders and plugins; plugins and files with comments are read-only", () => {
    const cmd = fakeCommand();
    write(path.join(home, ".cursor", "mcp.json"), { mcpServers: { "ava-harness": harness(cmd) } });
    write(folderFile(), `{\n  // comment\n  "mcpServers": { "x": { "command": "${cmd}", }, },\n}`);
    write(path.join(home, ".claude.json"), { mcpServers: { claude: { command: cmd } } });
    write(path.join(project, ".mcp.json"), { mcpServers: { claude: { command: cmd } } });
    const cache = path.join(home, ".cursor", "plugins", "cache", "market", "gctk");
    write(path.join(cache, "old", "mcp.json"), { mcpServers: { old: { command: "node" } } });
    fs.utimesSync(path.join(cache, "old"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    write(path.join(cache, "new", "mcp.json"), { mcpServers: { gctk: { command: "node", args: ["${CURSOR_PLUGIN_ROOT}/dist/gctk.js", "mcp"] } } });
    write(path.join(cache, "new", ".mcp.json"), { mcpServers: { gctk: { command: "node" } } });

    const files = configFiles(opts);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(files.every((f) => f.editor === "cursor")).toBe(true);
    expect(byPath.get(path.join(home, ".cursor", "mcp.json"))).toMatchObject({ scope: "user", exists: true, editable: true });
    expect(byPath.get(folderFile())).toMatchObject({ scope: "project", project, editable: false, error: expect.stringMatching(/comments/) });
    expect(byPath.get(path.join(cache, "new", "mcp.json"))).toMatchObject({ scope: "plugin", editable: false, plugin: "gctk" });
    expect(byPath.has(path.join(cache, "new", ".mcp.json"))).toBe(false); // Cursor reads mcp.json only
    expect(byPath.has(path.join(cache, "old", "mcp.json"))).toBe(false); // only the newest version
    expect(byPath.has(path.join(home, ".claude.json"))).toBe(false);

    const s = scanAiSetup(opts);
    expect(s.servers.map((x) => x.name).sort()).toEqual(["ava-harness", "gctk", "x"]);
    expect(s.servers.find((x) => x.name === "gctk")).toMatchObject({ credentials: "gctk-profile", editable: false });
  });

  it("reads JSON with comments and trailing commas", () => {
    expect(parseJsonc('{ "a": "http://x//y", /* c */ "b": [1,], }')).toEqual({ value: { a: "http://x//y", b: [1] }, comments: true });
  });

  it("adds and removes locations; an added file is read as a Cursor config", () => {
    const f = path.join(tmp, "elsewhere", ".cursor", "mcp.json");
    write(f, { mcpServers: {} });
    addLocation(f, home);
    expect(configFiles(opts).find((x) => x.path === f)).toMatchObject({ editor: "cursor", added: true });
    expect(() => addLocation(path.join(tmp, "missing"), home)).toThrow(/does not exist/);
    removeLocation(f);
    expect(configFiles(opts).some((x) => x.path === f)).toBe(false);
  });
});

describe("servers", () => {
  it("masks secrets, names the org and flags plain text, copies, old variables and missing commands", () => {
    const cmd = fakeCommand();
    const js = path.join(tmp, "dist", "gctk.js");
    write(js, "");
    write(path.join(home, ".cursor", "mcp.json"), { mcpServers: { "ava-harness": harness(cmd), gone: { command: path.join(tmp, "nope") }, gctk: { command: "node", args: [js, "mcp"], env: { GCTK_WORKSPACE: "1", GCTK_PROFILE: "sandbox-org" } } } });
    write(folderFile(), { mcpServers: { "ava-harness": harness(cmd) } });
    const s = scanAiSetup(opts);
    const h = s.servers.find((x) => x.file === path.join(home, ".cursor", "mcp.json") && x.name === "ava-harness")!;
    expect(h).toMatchObject({ genesys: true, credentials: "plain", org: { profile: "sandbox-org", region: "mypurecloud.de", clientId: "485c8ae1…" } });
    expect(h.env.find((v) => v.name === "GENESYS_CLIENT_SECRET")).toEqual({ name: "GENESYS_CLIENT_SECRET", value: "••••1234", secret: true, plain: true });
    expect(h.problems.map((p) => p.fix)).toContain("keychain");
    expect(h.problems.some((p) => p.text.includes(`also written in: ${folderFile()}`))).toBe(true);
    expect(s.servers.find((x) => x.name === "gone")!.problems[0]).toMatchObject({ level: "warn", fix: "remove", text: expect.stringMatching(/does not exist/) });
    expect(s.servers.find((x) => x.name === "gctk")).toMatchObject({ credentials: "gctk-profile", org: { profile: "sandbox-org" }, problems: [expect.objectContaining({ fix: "clean-env" })] });

    const text = formatAiSetup(s);
    expect(text).not.toContain(SECRET);
    expect(text).toMatch(/gctk profile sandbox-org/);
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });

  it("does not treat references as plain secrets", () => {
    write(path.join(home, ".cursor", "mcp.json"), { mcpServers: { a: { command: "node", env: { GENESYS_CLIENT_SECRET: "${env:GC_SECRET}", GENESYS_REGION: "${user_config.region}" } } } });
    const a = scanAiSetup(opts).servers[0]!;
    expect(a.credentials).toBe("reference");
    expect(a.org).toBeUndefined();
    expect(a.problems).toEqual([]);
  });
});

describe("fixes", () => {
  const cursorFile = () => path.join(home, ".cursor", "mcp.json");
  const addr = (file = cursorFile()) => ({ file, section: "mcpServers", name: "ava-harness" });
  const gctkJs = () => {
    const js = path.join(tmp, "dist", "gctk.js");
    write(js, "");
    return js;
  };

  it("moves the secret to the keychain behind a signed launch record, and back", () => {
    const cmd = fakeCommand();
    const original = { mcpServers: { "ava-harness": { ...harness(cmd), timeout: 60000 }, other: { command: "x" } } };
    write(cursorFile(), original);
    const { id, account } = moveToKeychain(addr(), { ...opts, gctkJs: gctkJs(), node: "/usr/bin/node" });

    const file = fs.readFileSync(cursorFile(), "utf8");
    expect(file).not.toContain(SECRET);
    expect(read(cursorFile()).mcpServers["ava-harness"]).toEqual({ command: "/usr/bin/node", args: [path.join(tmp, "dist", "gctk.js"), "mcp-launch", id], timeout: 60000 });
    expect(read(cursorFile()).mcpServers.other).toEqual({ command: "x" });
    expect(JSON.parse(mem.get(account)!)).toEqual({ GENESYS_CLIENT_SECRET: SECRET });

    // The child gets the record's environment, not what the editor or the config passes.
    const spec = launchSpec(id, { NODE_OPTIONS: "--require /tmp/evil.js", PATH: "/evil", LANG: "de_DE.UTF-8" }, store);
    expect(spec.command).toBe(cmd);
    expect(spec.args).toEqual(["serve"]);
    expect(spec.env).toMatchObject({ GENESYS_CLIENT_SECRET: SECRET, GENESYS_CLIENT_ID: CLIENT, AVA_HABITAT: "prod-euc1", LANG: "de_DE.UTF-8" });
    expect(spec.env.NODE_OPTIONS).toBeUndefined();
    expect(spec.env.PATH).not.toBe("/evil");

    const s = scanAiSetup(opts);
    const h = s.servers.find((x) => x.name === "ava-harness")!;
    expect(h).toMatchObject({ credentials: "keychain", command: cmd, org: { profile: "sandbox-org" }, launch: { id, valid: true } });
    expect(h.env.find((v) => v.name === "GENESYS_CLIENT_SECRET")?.value).toBe("in the keychain");
    expect(s.secrets).toEqual([expect.objectContaining({ account, names: ["GENESYS_CLIENT_SECRET"], profile: "sandbox-org", stored: true })]);

    restoreToFile(addr(), opts);
    expect(read(cursorFile())).toEqual(original);
    expect(mem.has(account)).toBe(false);
    expect(() => launchSpec(id, {}, store)).toThrow(/No valid launch record/);
  });

  it("shares one keychain item for the same secret, so a new secret is entered once", () => {
    const cmd = fakeCommand();
    write(cursorFile(), { mcpServers: { "ava-harness": harness(cmd) } });
    write(folderFile(), { mcpServers: { "ava-harness": harness(cmd) } });
    const js = gctkJs();
    const a = moveToKeychain(addr(), { ...opts, gctkJs: js });
    const b = moveToKeychain(addr(folderFile()), { ...opts, gctkJs: js });
    expect(b.account).toBe(a.account);
    expect(scanAiSetup(opts).secrets[0]!.usedBy).toHaveLength(2);

    expect(() => updateSecret(a.account, {}, store)).toThrow(/GENESYS_CLIENT_SECRET/);
    updateSecret(a.account, { GENESYS_CLIENT_SECRET: "rotated-9999" }, store);
    expect(launchSpec(a.id, {}, store).env.GENESYS_CLIENT_SECRET).toBe("rotated-9999");
    expect(launchSpec(b.id, {}, store).env.GENESYS_CLIENT_SECRET).toBe("rotated-9999");

    // The item stays while another server still uses it.
    removeServer(addr(), opts);
    expect(mem.has(a.account)).toBe(true);
    removeServer(addr(folderFile()), opts);
    expect(mem.has(a.account)).toBe(false);
  });

  it("refuses an edited launch record", () => {
    const cmd = fakeCommand();
    write(cursorFile(), { mcpServers: { "ava-harness": harness(cmd) } });
    const { id } = moveToKeychain(addr(), { ...opts, gctkJs: gctkJs() });
    const recFile = path.join(process.env.GCTK_HOME!, "mcp-launch.json");
    const recs = read(recFile);
    recs.records[id].args = ["-c", "echo $GENESYS_CLIENT_SECRET"];
    write(recFile, recs);
    expect(() => launchSpec(id, {}, store)).toThrow(/No valid launch record/);
    expect(scanAiSetup(opts).servers[0]!.problems[0]!.text).toMatch(/launch record is missing or was changed/);
  });

  it("only changes files on the page, never plugin files, and removes old variables", () => {
    const cmd = fakeCommand();
    const cache = path.join(home, ".cursor", "plugins", "cache", "m", "p", "v1", "mcp.json");
    write(cache, { mcpServers: { "ava-harness": harness(cmd) } });
    expect(() => moveToKeychain(addr(cache), { ...opts, gctkJs: gctkJs() })).toThrow(/belongs to a plugin/);
    expect(() => removeServer(addr(path.join(tmp, "random.json")), opts)).toThrow(/not one of the config files/);

    write(cursorFile(), { mcpServers: { gctk: { command: "node", env: { GCTK_WORKSPACE: "1", GCTK_PROFILE: "x" } } } });
    expect(cleanEnv({ file: cursorFile(), section: "mcpServers", name: "gctk" }, opts)).toEqual(["GCTK_WORKSPACE"]);
    expect(read(cursorFile()).mcpServers.gctk.env).toEqual({ GCTK_PROFILE: "x" });
  });

  it("leaves no secret in the keychain when the move fails halfway", () => {
    const cmd = fakeCommand();
    write(cursorFile(), { mcpServers: { "ava-harness": harness(cmd) } });
    const blocked = path.join(tmp, "blocked-home");
    fs.writeFileSync(blocked, "a file where the gctk home should be");
    process.env.GCTK_HOME = blocked;
    expect(() => moveToKeychain(addr(), { ...opts, gctkJs: gctkJs() })).toThrow();
    expect(mem.size).toBe(0);
    expect(read(cursorFile()).mcpServers["ava-harness"].env.GENESYS_CLIENT_SECRET).toBe(SECRET);
  });

  it("keeps tab indentation of the file", () => {
    const cmd = fakeCommand();
    write(cursorFile(), JSON.stringify({ mcpServers: { "ava-harness": harness(cmd) } }, null, "\t"));
    moveToKeychain(addr(), { ...opts, gctkJs: gctkJs() });
    expect(fs.readFileSync(cursorFile(), "utf8")).toMatch(/^\{\n\t"mcpServers"/);
  });
});

describe("changing credentials", () => {
  const cursorFile = () => path.join(home, ".cursor", "mcp.json");
  const addr = (file = cursorFile()) => ({ file, section: "mcpServers", name: "ava-harness" });
  const gctkJs = () => {
    const js = path.join(tmp, "dist", "gctk.js");
    write(js, "");
    return js;
  };
  const NEW_ID = "99999999-aaaa-bbbb-cccc-dddddddddddd";

  it("writes new values into a plain entry and moves the secret to the keychain, or keeps it in the file", () => {
    const cmd = fakeCommand();
    write(cursorFile(), { mcpServers: { "ava-harness": harness(cmd) } });
    expect(scanAiSetup(opts).servers[0]!.credentialKeys).toEqual({ clientId: "GENESYS_CLIENT_ID", secret: "GENESYS_CLIENT_SECRET", habitat: "AVA_HABITAT" });
    setCredentials(addr(), { clientId: NEW_ID, secret: "new-secret-0001", region: "mypurecloud.ie" }, { ...opts, gctkJs: gctkJs() });
    expect(fs.readFileSync(cursorFile(), "utf8")).not.toContain("new-secret-0001");
    const id = read(cursorFile()).mcpServers["ava-harness"].args[2];
    expect(launchSpec(id, {}, store).env).toMatchObject({ GENESYS_CLIENT_ID: NEW_ID, GENESYS_CLIENT_SECRET: "new-secret-0001", AVA_HABITAT: "prod-euw1" });

    write(folderFile(), { mcpServers: { "ava-harness": harness(cmd) } });
    setCredentials(addr(folderFile()), { secret: "kept-in-file-1", keychain: false }, opts);
    expect(read(folderFile()).mcpServers["ava-harness"].env).toMatchObject({ GENESYS_CLIENT_ID: CLIENT, GENESYS_CLIENT_SECRET: "kept-in-file-1" });
    expect(() => setCredentials(addr(), {}, opts)).toThrow(/what should change/);
  });

  it("takes the credentials of a gctk org, and gives a server its own keychain item when it shared one", () => {
    const cmd = fakeCommand();
    write(cursorFile(), { mcpServers: { "ava-harness": harness(cmd) } });
    write(folderFile(), { mcpServers: { "ava-harness": harness(cmd) } });
    const js = gctkJs();
    const a = moveToKeychain(addr(), { ...opts, gctkJs: js });
    const b = moveToKeychain(addr(folderFile()), { ...opts, gctkJs: js });
    expect(b.account).toBe(a.account);

    saveProfile({ name: "demo-ie", region: "mypurecloud.ie", tier: "sandbox", credentials: "env" });
    process.env.GCTK_CLIENT_ID = NEW_ID;
    process.env.GCTK_CLIENT_SECRET = "org-secret-2222";
    setCredentials(addr(), { profile: "demo-ie" }, { ...opts, gctkJs: js });
    expect(launchSpec(a.id, {}, store).env).toMatchObject({ GENESYS_CLIENT_ID: NEW_ID, GENESYS_CLIENT_SECRET: "org-secret-2222", AVA_HABITAT: "prod-euw1" });
    // The other server keeps its own org and secret.
    expect(launchSpec(b.id, {}, store).env).toMatchObject({ GENESYS_CLIENT_ID: CLIENT, GENESYS_CLIENT_SECRET: SECRET });
    expect(scanAiSetup({ ...opts, clients: () => new Map([[CLIENT, "sandbox-org"], [NEW_ID, "demo-ie"]]) }).servers.find((x) => x.file === cursorFile())!.org).toMatchObject({ profile: "demo-ie" });
  });
});

describe("gctk entries across plugin updates", () => {
  it("keeps a copy of gctk that only a newer version replaces", () => {
    const v1 = path.join(tmp, "cache", "v1", "dist", "gctk.js");
    const v2 = path.join(tmp, "cache", "v2", "dist", "gctk.js");
    write(v1, "// gctk 1");
    write(v2, "// gctk 2");
    expect(ensureStableGctk(v1, "0.25.0")).toBe(stableGctkJs());
    expect(read(path.join(path.dirname(stableGctkJs()), "package.json"))).toMatchObject({ type: "module" });
    expect(fs.readFileSync(stableGctkJs(), "utf8")).toBe("// gctk 1");
    ensureStableGctk(v2, "0.26.0");
    expect(fs.readFileSync(stableGctkJs(), "utf8")).toBe("// gctk 2");
    // An older gctk still running elsewhere leaves the newer copy alone.
    ensureStableGctk(v1, "0.25.0");
    expect(fs.readFileSync(stableGctkJs(), "utf8")).toBe("// gctk 2");
    expect(ensureStableGctk(stableGctkJs())).toBe(stableGctkJs());
    expect([olderVersion("0.9.1", "0.10.0"), olderVersion("1.0.0", "0.10.0"), olderVersion("0.25.0", "0.25.0")]).toEqual([true, false, false]);
  });

  it("finds an entry whose gctk was deleted by an update and repairs it", () => {
    const file = path.join(project, ".cursor", "mcp.json");
    addLocation(project, home);
    const gone = path.join(tmp, "cache", "old", "dist", "gctk.js");
    write(file, { mcpServers: { "ava-harness": { command: process.execPath, args: [gone, "axl-harness", "--workshop", "w1", "--org", "sandbox-org"], timeout: 60000 } } });
    const entry = () => scanAiSetup(opts).servers.find((x) => x.file === file)!;
    expect(entry().problems).toEqual([expect.objectContaining({ kind: "missing-command", fix: "repair" })]);
    const stable = path.join(tmp, "gctk", "bin", "gctk.js");
    write(stable, "// gctk");
    repairServer({ file, section: "mcpServers", name: "ava-harness" }, { ...opts, gctkJs: stable });
    expect(read(file).mcpServers["ava-harness"]).toEqual({ command: process.execPath, args: [stable, "axl-harness", "--workshop", "w1", "--org", "sandbox-org"], timeout: 60000 });
    expect(entry().problems).toEqual([]);
    write(file, { mcpServers: { other: { command: process.execPath, args: ["serve"] } } });
    expect(() => repairServer({ file, section: "mcpServers", name: "other" }, { ...opts, gctkJs: stable })).toThrow(/does not start through gctk/);
  });
});

describe("tools for project folders", () => {
  it("offers the user's Genesys servers as templates, without any credential", () => {
    const cmd = path.join(tmp, "bin", "architect-mcp");
    write(cmd, "");
    fs.chmodSync(cmd, 0o755);
    write(path.join(home, ".cursor", "mcp.json"), { mcpServers: {
      "genesys-cloud-architect-mcp": { command: cmd, args: ["--stdio"], env: { GENESYS_CLIENT_ID: CLIENT, GENESYS_CLIENT_SECRET: SECRET, GENESYS_REGION: "mypurecloud.de", LOG_LEVEL: "info", OTHER_TOKEN: "${env:X}" } },
      "ava-harness": harness(cmd),
      weather: { command: cmd, env: { API_KEY: "k" } },
    } });
    const list = toolTemplates(opts);
    expect(list).toEqual([expect.objectContaining({ name: "genesys-cloud-architect-mcp", command: cmd, args: ["--stdio"], env: { LOG_LEVEL: "info" }, keys: { clientId: "GENESYS_CLIENT_ID", secret: "GENESYS_CLIENT_SECRET", region: "GENESYS_REGION" } })]);
    expect(JSON.stringify(list)).not.toContain(SECRET);
    expect(JSON.stringify(list)).not.toContain(CLIENT);
  });
});
