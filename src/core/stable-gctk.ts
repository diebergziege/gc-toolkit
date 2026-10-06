import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gctkHome } from "./paths.js";

/**
 * A copy of gctk.js in the gctk home that outlives plugin updates. Plugin installs live in a
 * versioned cache folder that the next update deletes, so editor config entries gctk writes
 * (AXL harness, servers started through the keychain) point to this copy instead. dist/gctk.js is
 * one self-contained file, so the copy runs on its own. A newer gctk replaces it; an older one
 * running somewhere else leaves it alone.
 */

declare const __GCTK_VERSION__: string;
const VERSION = typeof __GCTK_VERSION__ === "string" ? __GCTK_VERSION__ : "0.0.0";

export const stableGctkJs = () => path.join(gctkHome(), "bin", "gctk.js");

const parts = (v: string) => v.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
/** a < b as versions (major.minor.patch). */
export function olderVersion(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]!;
  return false;
}

const hash = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Brings the stable copy up to the running gctk (unless that one is older) and returns its path. */
export function ensureStableGctk(current: string, version = VERSION): string {
  const target = stableGctkJs();
  // gctk.js is an ES module; outside the plugin nothing else tells Node so.
  const pkg = path.join(path.dirname(target), "package.json");
  if (!fs.existsSync(pkg)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(pkg, `${JSON.stringify({ type: "module", private: true, description: "gctk for your editors (written by gctk)" }, null, 2)}\n`);
  }
  if (path.resolve(current) === path.resolve(target)) return target;
  const versionFile = `${target}.version`;
  let have: string | undefined;
  try {
    have = fs.readFileSync(versionFile, "utf8").trim();
  } catch {
    have = undefined;
  }
  const exists = fs.existsSync(target);
  if (exists && have && olderVersion(version, have)) return target;
  if (exists && hash(target) === hash(current)) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.copyFileSync(current, tmp);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, target);
  fs.writeFileSync(versionFile, `${version}\n`);
  return target;
}
