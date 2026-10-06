import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readSecret, writeSecret } from "./credentials.js";
import { gctkHome } from "./paths.js";

const KEY_ACCOUNT = "__approval-key__";

let cached: Buffer | undefined;

/**
 * Key that signs the AI setup page's launch records (ai-setup.ts), so an edited record cannot reuse
 * a secret from the keychain. Lives in the OS keychain; GCTK_APPROVAL_KEY overrides it (tests); a
 * 0600 file is the fallback where no keychain exists.
 */
export function approvalKey(): Buffer {
  if (process.env.GCTK_APPROVAL_KEY) return Buffer.from(process.env.GCTK_APPROVAL_KEY, "utf8");
  if (cached) return cached;
  try {
    let hex = readSecret(KEY_ACCOUNT);
    if (!hex) {
      hex = crypto.randomBytes(32).toString("hex");
      writeSecret(KEY_ACCOUNT, hex);
    }
    cached = Buffer.from(hex, "hex");
  } catch {
    const file = path.join(gctkHome(), "approval.key");
    if (!fs.existsSync(file)) {
      fs.mkdirSync(gctkHome(), { recursive: true });
      fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
    }
    cached = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
  }
  return cached;
}

export function sign(message: string): string {
  return crypto.createHmac("sha256", approvalKey()).update(message).digest("hex");
}

export function verify(message: string, signature: string): boolean {
  const expected = Buffer.from(sign(message), "hex");
  const actual = Buffer.from(signature, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
