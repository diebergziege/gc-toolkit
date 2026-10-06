// Text imports bundled by esbuild (scripts/build.mjs) and vitest (vitest.config.ts).
declare module "*.html" {
  const content: string;
  export default content;
}
