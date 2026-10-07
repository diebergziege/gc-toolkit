import { Command, Option } from "commander";
import { runLaunch } from "../core/ai-setup.js";
import { runHarness, runProjectTool } from "../core/axl.js";
import { GenesysClient } from "../core/client.js";
import { deleteCredentials, hasStoredCredentials, keychainName, storeCredentials } from "../core/credentials.js";
import { setSnapshotSource, snapshotSource } from "../core/demos.js";
import { ensureStableGctk, runningGctkJs } from "../core/stable-gctk.js";
import { formatError, GctkError } from "../core/errors.js";
import { toJson } from "../core/output.js";
import { paths } from "../core/paths.js";
import {
  assertProfileName,
  getActiveProfileName,
  listProfiles,
  loadProfile,
  removeProfile,
  resolveProfileName,
  saveProfile,
  setActiveProfileName,
  TIERS,
  type Tier,
} from "../core/profiles.js";
import { resolveRegion } from "../core/regions.js";
import { runMcpServer } from "../mcp/server.js";
import { ensureSharedUi, findRunningUi, runUiDaemon, stopRunningUi } from "../ui/daemon.js";
import { openBrowser, UI_PAGES } from "../ui/launcher.js";
import { DEFAULT_UI_PORT, startUi } from "../ui/server.js";
import { ask } from "./prompt.js";

declare const __GCTK_VERSION__: string;
const VERSION = typeof __GCTK_VERSION__ === "string" ? __GCTK_VERSION__ : "dev";

const program = new Command()
  .name("gctk")
  .description("Genesys Cloud Toolkit: a local UI that makes your AI setup and Genesys Cloud demos transparent")
  .version(VERSION)
  .option("-p, --profile <name>", "profile to use (default: GCTK_PROFILE or the active profile)");

// ---------------------------------------------------------------- profiles
const profile = program.command("profile").description("manage org connections (profiles)");

profile
  .command("add <name>")
  .description("create a profile and store its OAuth client credentials in the keychain")
  .requiredOption("-r, --region <region>", "domain (mypurecloud.de) or region key (eu-central-1)")
  .addOption(new Option("-t, --tier <tier>", "environment tier").choices([...TIERS]).makeOptionMandatory())
  .option("-d, --description <text>", "free text, e.g. customer or purpose")
  .option("--env-credentials", "read credentials from GCTK_CLIENT_ID / GCTK_CLIENT_SECRET instead of the keychain (CI)")
  .option("--no-login", "do not ask for credentials now")
  .action(async (name: string, o: { region: string; tier: Tier; description?: string; envCredentials?: boolean; login: boolean }) => {
    assertProfileName(name);
    if (listProfiles().includes(name)) throw new GctkError("PROFILE_EXISTS", `Profile "${name}" already exists.`);
    const p = {
      name,
      region: resolveRegion(o.region),
      tier: o.tier,
      description: o.description,
      credentials: o.envCredentials ? ("env" as const) : ("keychain" as const),
    };
    saveProfile(p);
    console.log(`Created profile "${name}" (${p.tier}, ${p.region})`);
    console.log(`  ${paths.profile(name)}`);
    if (!getActiveProfileName()) {
      setActiveProfileName(name);
      console.log("  set as active profile");
    }
    if (p.credentials === "keychain" && o.login) await login(name, {});
  });

profile
  .command("list")
  .description("list profiles")
  .action(() => {
    const active = getActiveProfileName();
    const names = listProfiles();
    if (!names.length) return console.log("No profiles yet. Create one: gctk profile add <name> --region <region> --tier <tier>");
    for (const n of names) {
      try {
        const p = loadProfile(n);
        const creds = hasStoredCredentials(p) ? "credentials ok" : "NO CREDENTIALS";
        console.log(`${n === active ? "*" : " "} ${n.padEnd(20)} ${p.tier.padEnd(10)} ${p.region.padEnd(22)} ${creds}`);
      } catch (err) {
        console.log(`  ${n.padEnd(20)} INVALID: ${formatError(err)}`);
      }
    }
  });

profile
  .command("show [name]")
  .description("show a profile")
  .action((name?: string) => {
    const p = loadProfile(name ?? resolveProfileName(program.opts().profile));
    console.log(toJson({ ...p, credentialsStored: hasStoredCredentials(p), file: paths.profile(p.name) }));
  });

profile
  .command("use <name>")
  .description("set the active profile (default for CLI and new MCP sessions)")
  .action((name: string) => {
    setActiveProfileName(name);
    const p = loadProfile(name);
    console.log(`Active profile: ${name} (${p.tier}, ${p.region})`);
  });

profile
  .command("remove <name>")
  .description("delete a profile and its stored credentials")
  .action((name: string) => {
    const p = loadProfile(name);
    if (p.credentials === "keychain") deleteCredentials(name);
    removeProfile(name);
    console.log(`Removed profile "${name}" and its keychain entry.`);
  });

// ------------------------------------------------------------- credentials
async function login(name: string, o: { fromEnv?: boolean }) {
  const p = loadProfile(name);
  if (p.credentials === "env") {
    throw new GctkError("ENV_PROFILE", `Profile "${name}" reads credentials from the environment; nothing to store.`);
  }
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  if (o.fromEnv) {
    clientId = process.env.GCTK_CLIENT_ID;
    clientSecret = process.env.GCTK_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new GctkError("MISSING_CREDENTIALS", "GCTK_CLIENT_ID / GCTK_CLIENT_SECRET are not set.");
  } else {
    console.log(`OAuth client (Client Credentials grant) for ${p.region}. Input is stored in the ${keychainName()}.`);
    clientId = await ask("Client ID: ");
    clientSecret = await ask("Client secret (hidden): ", { hidden: true });
  }
  if (!clientId || !clientSecret) throw new GctkError("MISSING_CREDENTIALS", "Client ID and secret are required.");
  storeCredentials(p, { clientId, clientSecret });
  console.log(`Stored credentials for "${name}". Verifying...`);
  const org = (await new GenesysClient(p, { source: "cli" }).get<{ id?: string; name?: string }>("/api/v2/organizations/me")).body;
  console.log(`OK: org ${org.name ?? org.id}`);
}

program
  .command("login [profile]")
  .description("store or replace OAuth client credentials for a profile in the OS keychain")
  .option("--from-env", "take them from GCTK_CLIENT_ID / GCTK_CLIENT_SECRET")
  .action((name: string | undefined, o: { fromEnv?: boolean }) => login(name ?? resolveProfileName(program.opts().profile), o));

program
  .command("logout [profile]")
  .description("delete stored credentials for a profile")
  .action((name?: string) => {
    const n = name ?? resolveProfileName(program.opts().profile);
    deleteCredentials(n);
    console.log(`Removed credentials for "${n}" from the ${keychainName()}.`);
  });

// ---------------------------------------------------------------------- ui
program
  .command("ui [page]")
  .description(`open the local web UI (runs in the background, shared by all sessions); page: ${UI_PAGES.join(", ")}`)
  .option("--port <n>", "port for --foreground (default: random free port)")
  .option("--no-open", "do not open the browser")
  .option("--foreground", "run in this terminal instead of the background (stop with Ctrl+C)")
  .option("--stop", "stop the background UI")
  .option("--daemon", "internal: run as the background UI process")
  .action(async (page: string | undefined, o: { port?: string; open: boolean; foreground?: boolean; stop?: boolean; daemon?: boolean }) => {
    if (o.daemon) return runUiDaemon({ port: o.port ? Number(o.port) : undefined });
    if (page && !(UI_PAGES as readonly string[]).includes(page)) throw new GctkError("INVALID_INPUT", `Unknown page "${page}". Pages: ${UI_PAGES.join(", ")}.`);
    const target = (url: string) => (page ? `${url}&view=${page}` : url);
    if (o.stop) return console.log(stopRunningUi() ? "Stopped the gctk UI." : "No gctk UI was running.");
    if (o.foreground) {
      const ui = await startUi({ port: o.port ? Number(o.port) : undefined, preferPort: DEFAULT_UI_PORT });
      console.log(`gctk UI running at ${ui.url}`);
      console.log("This link contains a session token; do not share it. Stop with Ctrl+C.");
      if (o.open) await openBrowser(target(ui.url));
      const stop = () => ui.close().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    const url = await ensureSharedUi();
    const running = await findRunningUi();
    console.log(`gctk UI is running in the background${running ? ` (pid ${running.info.pid})` : ""}: ${url}`);
    console.log("This link contains a session token; do not share it. Stop it with the button in the UI or `gctk ui --stop`.");
    if (o.open) await openBrowser(target(url));
  });

// --------------------------------------------------------------------- axl
program
  .command("axl-harness", { hidden: true })
  .description("internal: Cursor starts this for the ava-harness MCP server (org and credentials from the AXL page)")
  .option("--workshop <id>", "the AXL workshop the folder belongs to")
  .option("--org <profile>", "the workshop's org; must match the AXL page")
  .action(async (o: { workshop?: string; org?: string }) => {
    try {
      process.exitCode = await runHarness({ workshop: o.workshop, org: o.org });
    } catch (err) {
      // stdout belongs to the MCP protocol; Cursor shows stderr in its MCP log.
      process.stderr.write(`gctk: ${formatError(err)}\n`);
      process.exitCode = 1;
    }
  });

// ------------------------------------------------------------------- demos
program
  .command("demo-source <demo> [profile]", { hidden: true })
  .description("maintainer: the org this computer takes the demo's snapshot from (kept in the gctk home, never in the package)")
  .option("--replace <value=with...>", "texts of the source org to replace in the snapshot, e.g. a person's name")
  .option("--clear", "remove the snapshot source")
  .action((demo: string, name: string | undefined, o: { replace?: string[]; clear?: boolean }) => {
    if (o.clear) {
      setSnapshotSource(demo, undefined);
      return console.log(`${demo}: no snapshot source on this computer.`);
    }
    if (name) {
      const replace = (o.replace ?? []).map((r) => {
        const at = r.indexOf("=");
        if (at < 1) throw new GctkError("INVALID_INPUT", `--replace needs value=with, got "${r}".`);
        return { value: r.slice(0, at), with: r.slice(at + 1) };
      });
      setSnapshotSource(demo, { profile: name, ...(replace.length ? { replace } : {}) });
    }
    const s = snapshotSource(demo);
    if (!s) return console.log(`${demo}: no snapshot source on this computer.`);
    console.log(`${demo}: snapshots come from ${s.profile}`);
    for (const r of s.replace ?? []) console.log(`  replace "${r.value}" with "${r.with}"`);
  });

program
  .command("project-tool", { hidden: true })
  .description("internal: Cursor starts this for a Genesys tool of a gctk project folder (org and credentials from the Projects page)")
  .option("--project <id>", "the project the folder belongs to")
  .option("--tool <name>", "the tool, as set up for the project")
  .action(async (o: { project?: string; tool?: string }) => {
    try {
      process.exitCode = await runProjectTool(o);
    } catch (err) {
      // stdout belongs to the MCP protocol; Cursor shows stderr in its MCP log.
      process.stderr.write(`gctk: ${formatError(err)}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("mcp-launch <id>", { hidden: true })
  .description("internal: the editor starts this for an MCP server whose secrets the AI setup page moved to the keychain")
  .action(async (id: string) => {
    try {
      process.exitCode = await runLaunch(id);
    } catch (err) {
      // stdout belongs to the MCP protocol; the editor shows stderr in its MCP log.
      process.stderr.write(`gctk: ${formatError(err)}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("mcp")
  .description("run the MCP server on stdio (used by Cursor / Claude Code to open the UI)")
  .action(() => {
    // The editor starts this after every plugin update: refresh the copy that config entries use.
    try {
      const js = runningGctkJs();
      if (js) ensureStableGctk(js);
    } catch {
      // a read-only home: the entries keep the copy they have
    }
    return runMcpServer();
  });

program.parseAsync().catch((err) => {
  console.error(formatError(err));
  process.exit(1);
});
