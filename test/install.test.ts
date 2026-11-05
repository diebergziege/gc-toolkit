import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataInfo } from "../src/core/data-info.js";
import { appDir, appGctkJs, installGctk, loadInstallRecord, readGctkTarball, uninstallGctk, untar, updateInstalledGctk } from "../src/core/install.js";
import { gctkInstall } from "../src/core/updates.js";

let tmp: string;
let home: string;
let claudeConfig: string;
const saved = { ...process.env };
const JS = "#!/usr/bin/env node\nconsole.log('gctk');\n";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-install-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home);
  process.env.GCTK_HOME = path.join(tmp, "gctk");
  claudeConfig = path.join(tmp, "Claude", "claude_desktop_config.json");
  process.env.GCTK_CLAUDE_APP_CONFIG = claudeConfig;
});
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The running gctk: dist/gctk.js with demos next to it, as in the plugin or npx. */
function source() {
  const dir = path.join(tmp, "src");
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.mkdirSync(path.join(dir, "demos", "lumea"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "gctk.js"), JS);
  fs.writeFileSync(path.join(dir, "demos", "lumea", "demo.yaml"), "id: lumea\n");
  return { from: path.join(dir, "dist", "gctk.js"), demos: path.join(dir, "demos") };
}

describe("gctk install", () => {
  it("macOS: copies gctk with its demos, adds a command, an app and the Claude app entry", () => {
    fs.mkdirSync(path.dirname(claudeConfig), { recursive: true });
    fs.writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { other: { command: "x" } }, preferences: { a: 1 } }, null, "\t"));
    const env = { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" };
    const r = installGctk({ ...source(), version: "1.2.3", node: "/usr/local/bin/node", home, platform: "darwin", env });

    expect(fs.readFileSync(appGctkJs(), "utf8")).toBe(JS);
    expect(fs.existsSync(path.join(appDir(), "demos", "lumea", "demo.yaml"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(appDir(), "package.json"), "utf8"))).toMatchObject({ version: "1.2.3", type: "module" });
    expect(gctkInstall(appGctkJs(), home)).toBe("app");

    const cmd = path.join(home, ".local", "bin", "gctk");
    expect(r.command).toBe(cmd);
    expect(fs.statSync(cmd).mode & 0o111).toBeTruthy();
    expect(fs.readFileSync(cmd, "utf8")).toContain(`exec "$NODE" '${appGctkJs()}' "$@"`);
    expect(fs.readFileSync(cmd, "utf8")).toContain("NODE='/usr/local/bin/node'");
    expect(fs.readFileSync(path.join(home, ".zshrc"), "utf8")).toBe('export PATH="$HOME/.local/bin:$PATH" # gctk\n');

    const bundle = path.join(home, "Applications", "gctk.app");
    expect(r.launcher).toBe(bundle);
    expect(fs.readFileSync(path.join(bundle, "Contents", "MacOS", "gctk"), "utf8")).toMatch(/' ui\n$/);
    expect(fs.readFileSync(path.join(bundle, "Contents", "Info.plist"), "utf8")).toContain("<key>CFBundleExecutable</key><string>gctk</string>");

    expect(r.claudeApp).toBe("added");
    const cfg = JSON.parse(fs.readFileSync(claudeConfig, "utf8"));
    expect(cfg).toEqual({ mcpServers: { other: { command: "x" }, gctk: { command: "/usr/local/bin/node", args: [appGctkJs(), "mcp"] } }, preferences: { a: 1 } });
    expect(fs.readFileSync(claudeConfig, "utf8")).toMatch(/^\{\n\t"mcpServers"/);

    // Again: nothing doubles; gctk's own Claude app entry is refreshed, one of the user's own is kept.
    const again = installGctk({ ...source(), version: "1.2.4", node: "/usr/local/bin/node", home, platform: "darwin", env });
    expect(again.claudeApp).toBe("ours");
    expect(fs.readFileSync(path.join(home, ".zshrc"), "utf8").match(/# gctk/g)).toHaveLength(1);
    expect(loadInstallRecord()).toMatchObject({ version: "1.2.4", files: [cmd, bundle], rc: { file: path.join(home, ".zshrc") } });
    expect(loadInstallRecord()?.claudeApp).toBe(claudeConfig);
    expect(dataInfo({ has: () => false }).elsewhere.map((e) => e.path)).toEqual(expect.arrayContaining([cmd, bundle, path.join(home, ".zshrc")]));

    const removed = uninstallGctk();
    expect(removed).toEqual(expect.arrayContaining([cmd, bundle, appDir()]));
    for (const p of [cmd, bundle, appDir()]) expect(fs.existsSync(p)).toBe(false);
    expect(fs.readFileSync(path.join(home, ".zshrc"), "utf8")).not.toContain("gctk");
    expect(JSON.parse(fs.readFileSync(claudeConfig, "utf8")).mcpServers).toEqual({ other: { command: "x" } });
    expect(loadInstallRecord()).toBeUndefined();
  });

  it("leaves the PATH alone when the command folder is on it, and skips a missing Claude app", () => {
    const bin = path.join(home, ".local", "bin");
    const r = installGctk({ ...source(), version: "1.0.0", node: "/n", home, platform: "linux", env: { PATH: `${bin}:/usr/bin`, GCTK_HOME: "/x y/gctk" } });
    expect(r.rc).toBeUndefined();
    expect(r.claudeApp).toBe("not-installed");
    const desktop = fs.readFileSync(path.join(home, ".local", "share", "applications", "gctk.desktop"), "utf8");
    expect(desktop).toContain(`Exec=env GCTK_HOME="/x y/gctk" "/n" "${appGctkJs()}" ui`);
    expect(fs.readFileSync(path.join(bin, "gctk"), "utf8")).toContain("export GCTK_HOME='/x y/gctk'");
  });

  it("Windows: a gctk.cmd, the user PATH and shortcuts through PowerShell", () => {
    const calls: string[][] = [];
    const env = { LOCALAPPDATA: path.join(home, "Local"), APPDATA: path.join(home, "Roaming"), USERPROFILE: home };
    const r = installGctk({ ...source(), version: "1.0.0", node: "C:\\Program Files\\nodejs\\node.exe", home, platform: "win32", env, claudeApp: false, run: (c, a) => (calls.push([c, ...a]), { code: 0, output: "" }) });
    const cmd = path.join(home, "Local", "gctk", "bin", "gctk.cmd");
    expect(r.command).toBe(cmd);
    expect(fs.readFileSync(cmd, "utf8")).toContain(`"C:\\Program Files\\nodejs\\node.exe" "${appGctkJs()}" %*`);
    const script = calls[0]!.at(-1)!;
    expect(calls[0]![0]).toBe("powershell.exe");
    expect(script).toContain("SetEnvironmentVariable('Path'");
    expect(script).toContain(path.join(home, "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "gctk.lnk"));
    expect(script).toContain(`$s.Arguments = '"${appGctkJs()}" ui'`);
    expect(loadInstallRecord()?.winPath).toBe(path.dirname(cmd));

    const failed = installGctk({ ...source(), version: "1.0.0", node: "n", home, platform: "win32", env, claudeApp: false, run: () => ({ code: 1, output: "blocked by policy" }) });
    expect(failed.launcher).toBeUndefined();
    expect(failed.notes[0]).toMatch(/blocked by policy/);
  });
});

// --------------------------------------------------------------- tarballs

function tarHeader(name: string, size: number, type: string, prefix = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write("0000644\0", 100);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  h.write(prefix, 345, 155);
  return h;
}
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
function tar(entries: Array<[string, string]>): Buffer {
  const parts: Buffer[] = [];
  const pax = Buffer.from("52 comment=a00d7fc6bd0d38dd1a1d6b3b2e09d9d6a00b3ba4\n");
  parts.push(tarHeader("pax_global_header", pax.length, "g"), pad(pax));
  for (const [name, text] of entries) {
    const data = Buffer.from(text);
    if (name.length > 100) {
      const rec = ` path=${name}\n`;
      const len = String(rec.length + String(rec.length + 3).length).length + rec.length;
      const paxData = Buffer.from(`${len}${rec}`);
      parts.push(tarHeader("PaxHeader", paxData.length, "x"), pad(paxData));
      parts.push(tarHeader(name.slice(0, 100), data.length, "0"), pad(data));
    } else if (name.includes("/demos/")) {
      const at = name.lastIndexOf("/");
      parts.push(tarHeader(name.slice(at + 1), data.length, "0", name.slice(0, at)), pad(data));
    } else parts.push(tarHeader(name, data.length, "0"), pad(data));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

describe("updating the installed gctk", () => {
  const longName = `gc-toolkit-main/demos/lumea/${"x".repeat(90)}.json`;
  const tgz = () => tar([["gc-toolkit-main/package.json", '{"version":"9.9.9"}'], ["gc-toolkit-main/dist/gctk.js", JS], ["gc-toolkit-main/demos/lumea/demo.yaml", "id: lumea\n"], [longName, "{}"], ["gc-toolkit-main/src/x.ts", "no"]]);

  it("reads GitHub's tarball: ustar prefixes, pax paths and the global header", () => {
    const names = untar(zlib.gunzipSync(tgz())).map(([n]) => n);
    expect(names).toEqual(["gc-toolkit-main/package.json", "gc-toolkit-main/dist/gctk.js", "gc-toolkit-main/demos/lumea/demo.yaml", longName, "gc-toolkit-main/src/x.ts"]);
    const r = readGctkTarball(tgz());
    expect(r.version).toBe("9.9.9");
    expect(r.js.toString()).toBe(JS);
    expect(r.demos.map(([n]) => n)).toEqual(["lumea/demo.yaml", `lumea/${"x".repeat(90)}.json`]);
    expect(() => readGctkTarball(Buffer.from("nope"))).toThrow(/unpacked/);
    expect(() => readGctkTarball(tar([["r/package.json", '{"version":"1.0.0"}']]))).toThrow(/no gctk/);
  });

  it("replaces app/ with the download and keeps the record's version up to date", async () => {
    installGctk({ ...source(), version: "1.0.0", node: "/n", home, platform: "linux", env: { PATH: "" }, claudeApp: false });
    fs.writeFileSync(path.join(appDir(), "demos", "old.txt"), "gone after the update");
    const fetchTgz = (async () => new Response(new Uint8Array(tgz()))) as unknown as typeof fetch;
    expect(await updateInstalledGctk({ fetch: fetchTgz })).toEqual({ from: "1.0.0", to: "9.9.9" });
    expect(JSON.parse(fs.readFileSync(path.join(appDir(), "package.json"), "utf8")).version).toBe("9.9.9");
    expect(fs.existsSync(path.join(appDir(), "demos", "lumea", "demo.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(appDir(), "demos", "old.txt"))).toBe(false);
    expect(loadInstallRecord()?.version).toBe("9.9.9");
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    await expect(updateInstalledGctk({ fetch: down })).rejects.toThrow(/503/);
    expect(JSON.parse(fs.readFileSync(path.join(appDir(), "package.json"), "utf8")).version).toBe("9.9.9");
  });
});

describe("the Claude app's own gctk", () => {
  it("is never replaced or removed", () => {
    fs.mkdirSync(path.dirname(claudeConfig), { recursive: true });
    fs.writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { gctk: { command: "npx", args: ["-y", "x", "mcp"] } } }));
    const src = path.join(tmp, "s.js");
    fs.writeFileSync(src, JS);
    expect(installGctk({ from: src, version: "1.0.0", node: "/n", home, platform: "linux", env: { PATH: "" } }).claudeApp).toBe("kept");
    uninstallGctk();
    expect(JSON.parse(fs.readFileSync(claudeConfig, "utf8")).mcpServers.gctk.command).toBe("npx");
  });
});
