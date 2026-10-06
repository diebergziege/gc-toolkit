import os from "node:os";
import path from "node:path";

/** Root of all local toolkit state. Override with GCTK_HOME (tests, CI, multiple setups). */
export function gctkHome(): string {
  if (process.env.GCTK_HOME) return process.env.GCTK_HOME;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "gctk");
}

export const paths = {
  profilesDir: () => path.join(gctkHome(), "profiles"),
  profile: (name: string) => path.join(gctkHome(), "profiles", `${name}.yaml`),
  config: () => path.join(gctkHome(), "config.yaml"),
  cacheDir: () => path.join(gctkHome(), "cache"),
};
