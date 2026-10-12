import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tests never read or write the real Claude app config; a test that needs one points this to its own.
  test: { env: { GCTK_CLAUDE_APP_CONFIG: path.join(os.tmpdir(), "gctk-test-no-claude-app", "claude_desktop_config.json") } },
  plugins: [
    {
      name: "html-as-text",
      enforce: "pre",
      load(id) {
        if (id.endsWith(".html")) return `export default ${JSON.stringify(fs.readFileSync(id, "utf8"))};`;
      },
    },
  ],
});
