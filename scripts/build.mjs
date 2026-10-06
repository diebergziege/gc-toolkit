// Bundles CLI + MCP server into one self-contained file. dist/ is committed on
// purpose: plugin installs clone the repo and do not run `npm install`.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
let buildId = "dev";
try {
  buildId = execSync("git rev-parse --short HEAD", { cwd: new URL("..", import.meta.url), encoding: "utf8" }).trim();
} catch {
  /* not a git checkout */
}

await build({
  entryPoints: ["src/cli/index.ts"],
  outfile: "dist/gctk.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  loader: { ".html": "text" },
  define: { __GCTK_VERSION__: JSON.stringify(pkg.version), __GCTK_BUILD_ID__: JSON.stringify(buildId) },
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __gctkCreateRequire } from 'node:module';",
      "const require = __gctkCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});

console.log(`built dist/gctk.js (v${pkg.version})`);
