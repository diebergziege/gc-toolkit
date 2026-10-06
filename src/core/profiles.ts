import fs from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import { GctkError } from "./errors.js";
import { paths } from "./paths.js";
import { resolveRegion } from "./regions.js";

export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A label for the kind of org; the UI shows it, and AXL works only with sandbox and dev orgs. */
export const TIERS = ["sandbox", "dev", "test", "production"] as const;
export type Tier = (typeof TIERS)[number];

const ProfileFileSchema = z.object({
  region: z.string(),
  tier: z.enum(TIERS),
  description: z.string().optional(),
  /** keychain: OS keychain (default). env: GCTK_CLIENT_ID / GCTK_CLIENT_SECRET, for CI. */
  credentials: z.enum(["keychain", "env"]).default("keychain"),
});

export interface Profile {
  name: string;
  region: string;
  tier: Tier;
  description?: string;
  credentials: "keychain" | "env";
}

export function assertProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new GctkError(
      "INVALID_PROFILE_NAME",
      `Invalid profile name "${name}".`,
      "Use lowercase letters, digits and dashes, e.g. prod-de or dev-lumea.",
    );
  }
}

export function loadProfile(name: string): Profile {
  assertProfileName(name);
  const file = paths.profile(name);
  if (!fs.existsSync(file)) {
    throw new GctkError("PROFILE_NOT_FOUND", `Profile "${name}" does not exist.`, "Create it with: gctk profile add <name>");
  }
  const parsed = ProfileFileSchema.safeParse(YAML.parse(fs.readFileSync(file, "utf8")) ?? {});
  if (!parsed.success) {
    throw new GctkError("INVALID_PROFILE", `Profile "${name}" (${file}) is invalid: ${z.prettifyError(parsed.error)}`);
  }
  const data = parsed.data;
  return {
    name,
    region: resolveRegion(data.region),
    tier: data.tier,
    description: data.description,
    credentials: data.credentials,
  };
}

export function saveProfile(p: Profile): void {
  assertProfileName(p.name);
  fs.mkdirSync(paths.profilesDir(), { recursive: true });
  const doc = {
    region: p.region,
    tier: p.tier,
    ...(p.description ? { description: p.description } : {}),
    credentials: p.credentials,
  };
  const header =
    "# Genesys Cloud Toolkit profile. Contains no secrets; credentials live in the OS keychain.\n";
  fs.writeFileSync(paths.profile(p.name), header + YAML.stringify(doc), { mode: 0o600 });
}

export function listProfiles(): string[] {
  const dir = paths.profilesDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.slice(0, -5))
    .sort();
}

export function removeProfile(name: string): void {
  assertProfileName(name);
  fs.rmSync(paths.profile(name), { force: true });
  if (getActiveProfileName() === name) setActiveProfileName(undefined);
}

interface ToolkitConfig {
  activeProfile?: string;
}

function readConfig(): ToolkitConfig {
  const file = paths.config();
  if (!fs.existsSync(file)) return {};
  return (YAML.parse(fs.readFileSync(file, "utf8")) as ToolkitConfig) ?? {};
}

export function getActiveProfileName(): string | undefined {
  return readConfig().activeProfile;
}

export function setActiveProfileName(name: string | undefined): void {
  const cfg = readConfig();
  if (name) {
    loadProfile(name);
    cfg.activeProfile = name;
  } else {
    delete cfg.activeProfile;
  }
  writeConfig(cfg);
}

function writeConfig(cfg: ToolkitConfig): void {
  fs.mkdirSync(paths.profilesDir(), { recursive: true });
  fs.writeFileSync(paths.config(), YAML.stringify(cfg), { mode: 0o600 });
}

/** Explicit name > GCTK_PROFILE > active profile from config.yaml. */
export function resolveProfileName(explicit?: string): string {
  const name = explicit || process.env.GCTK_PROFILE || getActiveProfileName();
  if (!name) {
    const available = listProfiles();
    throw new GctkError(
      "NO_PROFILE",
      "No Genesys Cloud profile selected.",
      available.length
        ? `Pick one with: gctk profile use <name>  (available: ${available.join(", ")})`
        : "Add one on the Orgs page of the gctk UI (the AI opens it with gc_ui), or with: gctk profile add <name> --region mypurecloud.de --tier dev",
    );
  }
  return name;
}
