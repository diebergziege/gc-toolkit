import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unzip } from "../src/core/axl-skills.js";

let out: string;
beforeAll(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-installers-"));
  const r = spawnSync(process.execPath, ["scripts/installers.mjs", out], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
});
afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

const only = (zip: string) => {
  const files = unzip(fs.readFileSync(path.join(out, zip)));
  expect(files).toHaveLength(1);
  return { name: files[0]![0], text: files[0]![1].toString("utf8") };
};

describe("the release downloads", () => {
  it("has a file to double-click for Mac and Windows, for gctk and gctk Partner", () => {
    expect(fs.readdirSync(out).sort()).toEqual(["gctk-mac.zip", "gctk-partner-mac.zip", "gctk-partner-windows.zip", "gctk-windows.zip", "install.ps1", "install.sh"]);
    expect(only("gctk-mac.zip")).toMatchObject({ name: "Install gctk.command", text: expect.stringContaining("\nDEFAULT_EDITION=full\n") });
    expect(only("gctk-partner-mac.zip")).toMatchObject({ name: "Install gctk Partner.command", text: expect.stringContaining("\nDEFAULT_EDITION=partner\n") });
    expect(only("gctk-windows.zip").text).toContain("$DefaultEdition = 'full'");
    expect(only("gctk-partner-windows.zip")).toMatchObject({ name: "Install gctk Partner.cmd", text: expect.stringContaining("$DefaultEdition = 'partner'") });
  });

  it("Mac: the script stays executable in the zip", () => {
    const buf = fs.readFileSync(path.join(out, "gctk-partner-mac.zip"));
    const central = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect((buf.readUInt32LE(central + 38) >>> 16) & 0o777).toBe(0o755);
    expect(spawnSync("sh", ["-n", path.join(out, "install.sh")]).status).toBe(0);
  });

  it("Windows: cmd starts PowerShell on the same file, which skips the cmd lines as a comment", () => {
    const { text } = only("gctk-windows.zip");
    expect(text.split("\r\n").slice(0, 8)).toEqual([
      "<# :",
      "@echo off",
      'set "GCTK_INSTALLER=%~f0"',
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression ([IO.File]::ReadAllText($env:GCTK_INSTALLER))"',
      "echo.",
      "pause",
      "exit /b",
      "#>",
    ]);
    expect(text.replace(/\r\n/g, "")).not.toMatch(/\n/);
    expect(/^[\x00-\x7f]*$/.test(text)).toBe(true);
  });
});
