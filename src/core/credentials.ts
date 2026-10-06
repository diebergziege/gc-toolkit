import { spawnSync } from "node:child_process";
import { GctkError } from "./errors.js";
import type { Profile } from "./profiles.js";

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

const SERVICE = "gctk";

/**
 * Secrets never touch profile files or process arguments: macOS gets them via
 * `security -i` on stdin, Linux via `secret-tool store` on stdin.
 */
interface KeychainBackend {
  name: string;
  get(account: string): string | undefined;
  set(account: string, value: string): void;
  remove(account: string): void;
}

const macos: KeychainBackend = {
  name: "macOS Keychain",
  get(account) {
    const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.replace(/\n$/, "") : undefined;
  },
  set(account, value) {
    // Base64 keeps the value free of quotes/whitespace for the `security -i` command parser.
    const encoded = Buffer.from(value, "utf8").toString("base64");
    const cmd = `add-generic-password -U -s ${SERVICE} -a ${account} -l "Genesys Cloud Toolkit (${account})" -w ${encoded}\n`;
    const r = spawnSync("security", ["-i"], { input: cmd, encoding: "utf8" });
    if (r.status !== 0 || /error/i.test(r.stderr)) {
      throw new GctkError("KEYCHAIN_WRITE_FAILED", `Could not write to the macOS Keychain: ${r.stderr.trim()}`);
    }
  },
  remove(account) {
    spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", account], { encoding: "utf8" });
  },
};

const linux: KeychainBackend = {
  name: "Secret Service (secret-tool)",
  get(account) {
    const r = spawnSync("secret-tool", ["lookup", "service", SERVICE, "account", account], { encoding: "utf8" });
    return r.status === 0 && r.stdout ? r.stdout.replace(/\n$/, "") : undefined;
  },
  set(account, value) {
    const r = spawnSync(
      "secret-tool",
      ["store", "--label", `Genesys Cloud Toolkit (${account})`, "service", SERVICE, "account", account],
      { input: value, encoding: "utf8" },
    );
    if (r.error || r.status !== 0) {
      throw new GctkError(
        "KEYCHAIN_WRITE_FAILED",
        `Could not write to the Secret Service: ${r.error?.message ?? r.stderr.trim()}`,
        "Install libsecret-tools (secret-tool), or use credentials: env with GCTK_CLIENT_ID / GCTK_CLIENT_SECRET.",
      );
    }
  },
  remove(account) {
    spawnSync("secret-tool", ["clear", "service", SERVICE, "account", account], { encoding: "utf8" });
  },
};

function backend(): KeychainBackend {
  if (process.platform === "darwin") return macos;
  if (process.platform === "linux") return linux;
  throw new GctkError(
    "KEYCHAIN_UNSUPPORTED",
    `No keychain backend for ${process.platform} yet.`,
    "Set credentials: env in the profile and provide GCTK_CLIENT_ID / GCTK_CLIENT_SECRET.",
  );
}

export function keychainName(): string {
  return backend().name;
}

/** What is stored: the credentials plus the profile identity they were entered for. */
interface StoredCredentials extends ClientCredentials {
  region?: string;
  tier?: string;
}

function decode(raw: string): StoredCredentials | undefined {
  try {
    // macOS stores the base64 form written above; secret-tool stores raw JSON.
    const json = raw.trimStart().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const v = JSON.parse(json) as Partial<StoredCredentials>;
    return v.clientId && v.clientSecret ? { clientId: v.clientId, clientSecret: v.clientSecret, region: v.region, tier: v.tier } : undefined;
  } catch {
    return undefined;
  }
}

/** Raw keychain access for toolkit-internal secrets (e.g. the key that signs AI setup's launch records). */
export function readSecret(account: string): string | undefined {
  const raw = backend().get(account);
  if (raw === undefined || process.platform !== "darwin") return raw;
  return Buffer.from(raw, "base64").toString("utf8");
}

export function writeSecret(account: string, value: string): void {
  backend().set(account, value);
}

export function removeSecret(account: string): void {
  backend().remove(account);
}

/**
 * Credentials are bound to the profile's region and tier at login. A profile file
 * edited (or forged in another GCTK_HOME) to claim a lower tier cannot use them.
 */
export function storeCredentials(profile: Pick<Profile, "name" | "region" | "tier">, creds: ClientCredentials): void {
  const stored: StoredCredentials = { ...creds, region: profile.region, tier: profile.tier };
  backend().set(profile.name, JSON.stringify(stored));
}

export function deleteCredentials(profileName: string): void {
  backend().remove(profileName);
}

export function hasStoredCredentials(profile: Profile): boolean {
  try {
    return loadCredentials(profile) !== undefined;
  } catch {
    return false;
  }
}

export function loadCredentials(profile: Profile): ClientCredentials {
  if (profile.credentials === "env") {
    const clientId = process.env.GCTK_CLIENT_ID;
    const clientSecret = process.env.GCTK_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new GctkError(
        "MISSING_CREDENTIALS",
        `Profile "${profile.name}" reads credentials from the environment, but GCTK_CLIENT_ID / GCTK_CLIENT_SECRET are not set.`,
      );
    }
    return { clientId, clientSecret };
  }
  const raw = backend().get(profile.name);
  const creds = raw ? decode(raw) : undefined;
  if (!creds) {
    throw new GctkError(
      "MISSING_CREDENTIALS",
      `No credentials stored for profile "${profile.name}" in the ${backend().name}.`,
      `Enter them in the gctk UI under Profiles (the agent opens it with gc_ui), or run: gctk login ${profile.name}`,
    );
  }
  if ((creds.tier && creds.tier !== profile.tier) || (creds.region && creds.region !== profile.region)) {
    throw new GctkError(
      "CREDENTIALS_BOUND",
      `The stored credentials for "${profile.name}" were entered for ${creds.tier}/${creds.region}, but the profile now says ${profile.tier}/${profile.region}.`,
      `If this change is intended, a human re-enters them with: gctk login ${profile.name}`,
    );
  }
  return { clientId: creds.clientId, clientSecret: creds.clientSecret };
}
