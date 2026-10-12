import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GCTK_PACKAGE, type ServerInfo } from "../src/core/ai-setup.js";
import { checkUpdates, GCTK_LATEST, type UpdateOptions, updateProgram } from "../src/core/updates.js";

let tmp: string;
let home: string;
let toolDir: string;
let calls: Array<{ command: string; args: string[] }>;
let opts: UpdateOptions;
const REL = "https://github.com/purecloudlabs/genesys-ava-skills/releases/download";

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const server = (name: string, command: string, args: string[] = []): ServerInfo =>
  ({ name, command, args, transport: "stdio", file: "", section: "mcpServers", key: name, editor: "cursor", scope: "user", editable: true, env: [], headers: [], disabled: false, genesys: true, credentials: "org", problems: [] }) as ServerInfo;
const distInfo = (v: string) => path.join(toolDir, "lib", "python3.12", "site-packages", `ava_mcp-${v}.dist-info`);
const fakeFetch = (routes: Record<string, unknown>): typeof fetch =>
  (async (url: string | URL | Request) => {
    const body = routes[String(url)];
    return body === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
const release = (v: string) => ({ assets: [{ name: `ava_mcp-${v}-py3-none-any.whl`, browser_download_url: `${REL}/v${v}/ava_mcp-${v}-py3-none-any.whl` }] });
const ava = () => server("ava-harness", path.join(home, ".local", "bin", "ava-mcp"), ["serve"]);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-updates-"));
  home = path.join(tmp, "home");
  toolDir = path.join(home, ".local", "share", "uv", "tools", "ava-mcp");
  const exe = path.join(home, ".local", "bin", "ava-mcp");
  write(path.join(toolDir, "uv-receipt.toml"), `[tool]\nrequirements = [{ name = "ava-mcp", url = "${REL}/v1.5.4/ava_mcp-1.5.4-py3-none-any.whl" }]\nentrypoints = [\n    { name = "ava-mcp", install-path = "${exe}", from = "ava-mcp" },\n]\n`);
  fs.mkdirSync(distInfo("1.5.4"), { recursive: true });
  write(exe, "#!/bin/sh\n");
  write(path.join(home, ".local", "bin", "uv"), "#!/bin/sh\n");
  calls = [];
  opts = {
    home,
    platform: "darwin",
    env: { PATH: path.join(home, ".local", "bin") },
    projectFolders: [],
    run: async (command, args) => {
      calls.push({ command, args });
      // uv installs the new wheel: its dist-info replaces the old one.
      const m = /ava_mcp-([\d.]+)-/.exec(args.join(" "));
      if (args[0] === "tool" && m) {
        fs.rmSync(distInfo("1.5.4"), { recursive: true, force: true });
        fs.mkdirSync(distInfo(m[1]!), { recursive: true });
      }
      return { code: 0, output: "" };
    },
  };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("uv tools from GitHub releases (ava-mcp)", () => {
  it("finds the tool behind a server and compares with the newest release", async () => {
    opts.fetch = fakeFetch({ "https://api.github.com/repos/purecloudlabs/genesys-ava-skills/releases/latest": release("1.6.0") });
    const [p] = await checkUpdates([ava(), server("other", "/usr/bin/true")], opts);
    expect(p).toMatchObject({ id: "uv:ava-mcp", kind: "uv-github", installed: "1.5.4", latest: "1.6.0", update: true, servers: ["ava-harness"] });
  });

  it("finds a bare command on PATH and says when it is the newest", async () => {
    opts.fetch = fakeFetch({ "https://api.github.com/repos/purecloudlabs/genesys-ava-skills/releases/latest": release("1.5.4") });
    const [p] = await checkUpdates([server("ava-harness", "ava-mcp", ["serve"])], opts);
    expect(p).toMatchObject({ installed: "1.5.4", latest: "1.5.4", update: false });
  });

  it("reports a failed check instead of throwing", async () => {
    opts.fetch = fakeFetch({});
    const [p] = await checkUpdates([ava()], opts);
    expect(p!.update).toBe(false);
    expect(p!.error).toMatch(/could not check/);
  });

  it("installs the newest wheel with uv and refreshes the AVA skills Cursor has", async () => {
    opts.fetch = fakeFetch({ "https://api.github.com/repos/purecloudlabs/genesys-ava-skills/releases/latest": release("1.6.0") });
    fs.mkdirSync(path.join(home, ".cursor", "skills", "ava-dispatch"), { recursive: true });
    const r = await updateProgram("uv:ava-mcp", [ava()], opts);
    expect(r).toMatchObject({ program: "ava-mcp", from: "1.5.4", to: "1.6.0", skills: [path.join(home, ".cursor")], skillErrors: [] });
    expect(calls[0]!.args).toEqual(["tool", "install", "--force", `${REL}/v1.6.0/ava_mcp-1.6.0-py3-none-any.whl`, "--reinstall-package", "ava-mcp"]);
    expect(calls[1]).toEqual({ command: path.join(home, ".local", "bin", "ava-mcp"), args: ["update", path.join(home, ".cursor"), "--yes"] });
  });

  it("leaves skills that are links alone (ava-mcp cannot replace them)", async () => {
    opts.fetch = fakeFetch({ "https://api.github.com/repos/purecloudlabs/genesys-ava-skills/releases/latest": release("1.6.0") });
    const shared = path.join(tmp, "shared", "ava-dispatch");
    fs.mkdirSync(shared, { recursive: true });
    fs.mkdirSync(path.join(home, ".cursor", "skills"), { recursive: true });
    fs.symlinkSync(shared, path.join(home, ".cursor", "skills", "ava-dispatch"));
    const r = await updateProgram("uv:ava-mcp", [ava()], opts);
    expect(r.skills).toEqual([]);
    expect(r.skillErrors[0]).toMatch(/links/);
    expect(calls).toHaveLength(1);
  });

  it("never installs a wheel from another repository", async () => {
    opts.fetch = fakeFetch({ "https://api.github.com/repos/purecloudlabs/genesys-ava-skills/releases/latest": { assets: [{ name: "ava_mcp-9.0.0-py3-none-any.whl", browser_download_url: "https://github.com/someone/else/releases/download/v9/ava_mcp-9.0.0-py3-none-any.whl" }] } });
    await expect(updateProgram("uv:ava-mcp", [ava()], opts)).rejects.toThrow(/no ava-mcp wheel/);
    expect(calls).toHaveLength(0);
  });

  it("shows uv's error when the install fails", async () => {
    opts.fetch = fakeFetch({ "https://api.github.com/repos/purecloudlabs/genesys-ava-skills/releases/latest": release("1.6.0") });
    opts.run = async () => ({ code: 2, output: "error: no network" });
    await expect(updateProgram("uv:ava-mcp", [ava()], opts)).rejects.toThrow(/no network/);
  });
});

describe("uv tools from PyPI", () => {
  it("upgrades with uv tool upgrade", async () => {
    write(path.join(toolDir, "uv-receipt.toml"), `[tool]\nrequirements = [{ name = "ava-mcp" }]\nentrypoints = [\n    { name = "ava-mcp", install-path = "${path.join(home, ".local", "bin", "ava-mcp")}", from = "ava-mcp" },\n]\n`);
    opts.fetch = fakeFetch({ "https://pypi.org/pypi/ava-mcp/json": { info: { version: "2.0.0" } } });
    const [p] = await checkUpdates([ava()], opts);
    expect(p).toMatchObject({ kind: "uv-pypi", latest: "2.0.0", update: true });
    await updateProgram("uv:ava-mcp", [ava()], opts);
    expect(calls[0]!.args).toEqual(["tool", "upgrade", "ava-mcp"]);
  });
});

describe("gctk started by npx", () => {
  const npxDir = (hash: string, spec: string, version?: string) => {
    const dir = path.join(home, ".npm", "_npx", hash);
    write(path.join(dir, "package.json"), JSON.stringify({ dependencies: { "genesys-cloud-toolkit": spec } }));
    if (version) write(path.join(dir, "node_modules", "genesys-cloud-toolkit", "package.json"), JSON.stringify({ version }));
    return dir;
  };

  it("finds the cached download and deletes it, nothing else", async () => {
    const old = npxDir("5f28cb8f26a2fea6", "github:diebergziege/gc-toolkit", "0.13.0");
    const mine = npxDir("a9b117469d3013c1", GCTK_PACKAGE, "0.29.0");
    const other = path.join(home, ".npm", "_npx", "1415fee72ff6294b");
    write(path.join(other, "package.json"), JSON.stringify({ dependencies: { "create-vite": "^9.0.2" } }));
    opts.fetch = fakeFetch({ [GCTK_LATEST]: { version: "0.31.0" } });
    const gctk = server("gctk", "npx", ["-y", GCTK_PACKAGE, "mcp"]);
    const [p] = await checkUpdates([gctk], opts);
    expect(p).toMatchObject({ id: "gctk", kind: "gctk-npx", installed: "0.29.0", latest: "0.31.0", update: true });
    const r = await updateProgram("gctk", [gctk], opts);
    expect(r.from).toBe("0.29.0");
    expect(fs.existsSync(mine)).toBe(false);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

it("refuses a program no server runs", async () => {
  await expect(updateProgram("uv:ava-mcp", [], opts)).rejects.toThrow(/does not know/);
});
