// Builds the downloads of the GitHub release (release/): a file to double-click for Mac and
// Windows, for gctk and for gctk Partner, plus the plain scripts for the terminal one-liners.
// They bring their own Node.js and download gctk from GitHub's main, so they only change when
// installer/ changes. The workflow .github/workflows/installers.yml publishes them.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = path.resolve(process.argv[2] ?? path.join(root, "release"));
const sh = fs.readFileSync(path.join(root, "installer", "install.sh"), "utf8");
const ps = fs.readFileSync(path.join(root, "installer", "install.ps1"), "utf8");

/** The script with another default edition; fails when the marker line is gone. */
function withEdition(text, marker, edition) {
  const next = text.replace(marker("full"), marker(edition));
  if (edition !== "full" && next === text) throw new Error(`installer: "${marker("full")}" not found`);
  return next;
}

// cmd runs the first lines, PowerShell reads the whole file and skips them as a block comment.
const cmdWrapper = (script) =>
  [
    "<# :",
    "@echo off",
    'set "GCTK_INSTALLER=%~f0"',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression ([IO.File]::ReadAllText($env:GCTK_INSTALLER))"',
    "echo.",
    "pause",
    "exit /b",
    "#>",
    script,
  ].join("\n").replace(/\r?\n/g, "\r\n");

/** A zip with Unix file modes, so the Mac's Archive Utility keeps the script executable. */
function zip(entries) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, mode = 0o644 } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const shMarker = (e) => `DEFAULT_EDITION=${e}\n`;
const psMarker = (e) => `$DefaultEdition = '${e}'`;
const assets = {
  "install.sh": Buffer.from(sh),
  "install.ps1": Buffer.from(ps),
};
for (const [edition, name] of [["full", "gctk"], ["partner", "gctk Partner"]]) {
  const suffix = edition === "partner" ? "-partner" : "";
  assets[`gctk${suffix}-mac.zip`] = zip([{ name: `Install ${name}.command`, data: Buffer.from(withEdition(sh, shMarker, edition)), mode: 0o755 }]);
  assets[`gctk${suffix}-windows.zip`] = zip([{ name: `Install ${name}.cmd`, data: Buffer.from(cmdWrapper(withEdition(ps, psMarker, edition))) }]);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const [name, data] of Object.entries(assets)) fs.writeFileSync(path.join(out, name), data);
console.log(`built ${Object.keys(assets).length} installer downloads in ${path.relative(process.cwd(), out) || "."}`);
