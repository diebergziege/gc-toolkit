import fs from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
