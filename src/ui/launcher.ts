import { spawn } from "node:child_process";

export const UI_PAGES = ["profiles", "ai-setup", "demos", "site", "demo", "axl", "monitoring", "data"] as const;
export type UiPage = (typeof UI_PAGES)[number];

/** Opens a folder in the Cursor app (macOS: the app; elsewhere Cursor's `cursor` command). */
export function openInCursor(dir: string): Promise<boolean> {
  if ((process.env.GCTK_BROWSER ?? "").toLowerCase() === "none") return Promise.resolve(false);
  const [cmd, args] = process.platform === "darwin" ? ["open", ["-a", "Cursor", dir]] : ["cursor", [dir]];
  return new Promise((resolve) => {
    const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

/**
 * Opens the URL in the user's default browser. Returns false when no browser can be
 * opened (headless machine, or GCTK_BROWSER=none for tests).
 */
export function openBrowser(url: string): Promise<boolean> {
  if ((process.env.GCTK_BROWSER ?? "").toLowerCase() === "none") return Promise.resolve(false);
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => resolve(false));
    child.on("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
