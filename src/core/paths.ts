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

/** Where desktop apps keep their settings (macOS Application Support, Windows %APPDATA%, else XDG). */
export function appSupportDir(home = os.homedir(), platform: NodeJS.Platform = process.platform, appData = process.env.APPDATA): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support");
  if (platform === "win32") return appData ?? path.join(home, "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME || path.join(home, ".config");
}

/** The Claude app's config (chat and Cowork): its local MCP servers live in mcpServers. GCTK_CLAUDE_APP_CONFIG overrides (tests). */
export function claudeAppConfigFile(home = os.homedir(), platform: NodeJS.Platform = process.platform, appData = process.env.APPDATA): string {
  if (process.env.GCTK_CLAUDE_APP_CONFIG) return process.env.GCTK_CLAUDE_APP_CONFIG;
  return path.join(appSupportDir(home, platform, appData), "Claude", "claude_desktop_config.json");
}
