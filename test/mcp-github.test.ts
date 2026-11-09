import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addCatalogServer } from "../src/core/ai-setup.js";
import { mcpServersDir, parseGithubUrl, readGithubRepo } from "../src/core/mcp-github.js";

let tmp: string;
const saved = { ...process.env };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-github-"));
  process.env.GCTK_HOME = path.join(tmp, "gctk");
});
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(tmp, { recursive: true, force: true });
});

function tgz(entries: Array<[string, string, number?]>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, text, mode = 0o644] of entries) {
    const data = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write("0", 156);
    h.write("ustar\0", 257);
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

/** The layout of MakingChatbots/genesys-cloud-plugins: a Claude Code plugin with userConfig. */
const PLUGIN: Array<[string, string, number?]> = [
  ["repo-abc/.claude-plugin/plugin.json", JSON.stringify({
    name: "genesys-cloud-architect", description: "Create Architect flows", mcpServers: "./.mcp.json", skills: "./skills/",
    userConfig: {
      genesys_region: { title: "Genesys Cloud region", description: "e.g. mypurecloud.de" },
      genesys_client_id: { title: "OAuth client ID" },
      genesys_client_secret: { title: "OAuth client secret", sensitive: true },
      flow_folder: { title: "Folder for flows" },
    },
  })],
  ["repo-abc/.mcp.json", JSON.stringify({ mcpServers: { "genesys-cloud-architect-mcp": {
    command: "node",
    args: ["${CLAUDE_PLUGIN_ROOT}/servers/architect.js"],
    env: {
      GENESYS_REGION: "${user_config.genesys_region}",
      GENESYS_CLIENT_ID: "${user_config.genesys_client_id}",
      GENESYS_CLIENT_SECRET: "${user_config.genesys_client_secret}",
      DEPLOY_SCRIPT_PATH: "${CLAUDE_PLUGIN_ROOT}/scripts/deploy.js",
      FLOW_FOLDER: "${user_config.flow_folder}",
    },
  } } })],
  ["repo-abc/servers/architect.js", "console.log(1)\n"],
  ["repo-abc/scripts/run.sh", "#!/bin/sh\n", 0o755],
  ["repo-abc/skills/write-flow/SKILL.md", "---\nname: write-flow\n---\n"],
  ["repo-abc/../escape.txt", "no"],
];

const fake = (body: Buffer, status = 200) => (async (url: string | URL | Request) => {
  fake.last = String(url);
  return new Response(new Uint8Array(body), { status });
}) as unknown as typeof fetch;
fake.last = "";

describe("MCP servers from GitHub", () => {
  it("reads links and owner/repo", () => {
    expect(parseGithubUrl("https://github.com/MakingChatbots/genesys-cloud-plugins")).toEqual({ owner: "MakingChatbots", repo: "genesys-cloud-plugins" });
    expect(parseGithubUrl("github.com/a/b.git/")).toEqual({ owner: "a", repo: "b" });
    expect(parseGithubUrl("a/b/tree/dev")).toEqual({ owner: "a", repo: "b", ref: "dev" });
    expect(() => parseGithubUrl("https://gitlab.com/a/b")).toThrow(/GitHub repository link/);
    expect(() => parseGithubUrl("../../etc")).toThrow();
  });

  it("downloads a plugin and turns its MCP config into a catalog entry with the org's credential variables", async () => {
    const r = await readGithubRepo("https://github.com/MakingChatbots/genesys-cloud-plugins", { fetch: fake(tgz(PLUGIN)) });
    expect(fake.last).toBe("https://github.com/MakingChatbots/genesys-cloud-plugins/archive/HEAD.tar.gz");
    const folder = path.join(mcpServersDir(), "MakingChatbots__genesys-cloud-plugins");
    expect(r.folder).toBe(folder);
    expect(r.skills).toEqual(["write-flow"]);
    expect(fs.existsSync(path.join(mcpServersDir(), "escape.txt")) || fs.existsSync(path.join(tmp, "gctk", "escape.txt"))).toBe(false);
    expect(fs.statSync(path.join(folder, "scripts", "run.sh")).mode & 0o111).toBeTruthy();

    expect(r.servers).toEqual([{
      name: "genesys-cloud-architect-mcp",
      description: "Create Architect flows",
      command: "node",
      args: [path.join(folder, "servers", "architect.js")],
      env: { DEPLOY_SCRIPT_PATH: path.join(folder, "scripts", "deploy.js"), FLOW_FOLDER: "" },
      keys: { region: "GENESYS_REGION", clientId: "GENESYS_CLIENT_ID", secret: "GENESYS_CLIENT_SECRET" },
      settings: [{ name: "FLOW_FOLDER", title: "Folder for flows" }],
      missing: ["scripts/deploy.js"],
    }]);

    const sv = r.servers[0]!;
    const added = addCatalogServer({ name: sv.name, source: r.source, command: sv.command, args: sv.args, env: { ...sv.env, FLOW_FOLDER: "/tmp/flows" },
      clientIdVar: sv.keys.clientId, secretVar: sv.keys.secret, regionVar: sv.keys.region, tiers: ["sandbox"] });
    expect(path.isAbsolute(added.command)).toBe(true);
    expect(added.keys).toEqual({ clientId: "GENESYS_CLIENT_ID", secret: "GENESYS_CLIENT_SECRET", region: "GENESYS_REGION" });
  });

  it("replaces an earlier download and explains a repository without an MCP server", async () => {
    await readGithubRepo("a/b", { fetch: fake(tgz(PLUGIN)) });
    await expect(readGithubRepo("a/b", { fetch: fake(tgz([["b-1/README.md", "hi"]])) })).rejects.toThrow(/no MCP server gctk can start/);
    expect(fs.existsSync(path.join(mcpServersDir(), "a__b", "servers"))).toBe(false);
    await expect(readGithubRepo("a/missing", { fetch: fake(Buffer.from(""), 404) })).rejects.toThrow(/no public repository a\/missing/);
  });

  it("reads a plain .mcp.json and skips remote servers", async () => {
    const r = await readGithubRepo("a/plain", { fetch: fake(tgz([
      ["p/package.json", JSON.stringify({ description: "plain server" })],
      ["p/mcp.json", JSON.stringify({ mcpServers: { remote: { url: "https://x" }, local: { command: "uvx", args: ["gc-mcp"], env: { GC_CLIENT_ID: "", GC_CLIENT_SECRET: "", GC_ENVIRONMENT: "" } } } })],
    ])) });
    expect(r.servers.map((s) => [s.name, s.description, s.keys, s.env])).toEqual([["local", "plain server", { clientId: "GC_CLIENT_ID", secret: "GC_CLIENT_SECRET", region: "GC_ENVIRONMENT" }, {}]]);
  });
});
