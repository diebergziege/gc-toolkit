import { GctkError } from "./errors.js";
import type { ClientCredentials } from "./credentials.js";
import { loginBase } from "./regions.js";

type Fetch = typeof fetch;

/** Client-credentials token with in-memory caching; refreshes 60 s before expiry. */
export class TokenProvider {
  private token?: string;
  private expiresAt = 0;
  private pending?: Promise<string>;

  constructor(
    private readonly domain: string,
    private readonly loadCreds: () => ClientCredentials,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async get(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;
    this.pending ??= this.fetchToken().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  invalidate(): void {
    this.token = undefined;
    this.expiresAt = 0;
  }

  private async fetchToken(): Promise<string> {
    const { clientId, clientSecret } = this.loadCreds();
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await this.fetchImpl(`${loginBase(this.domain)}/oauth/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GctkError(
        "AUTH_FAILED",
        `Token request to login.${this.domain} failed with HTTP ${res.status}. ${text.slice(0, 200)}`,
        res.status === 400 || res.status === 401
          ? "Check the region and the client ID/secret (gctk login <profile>). The client must use the Client Credentials grant."
          : undefined,
      );
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = body.access_token;
    this.expiresAt = Date.now() + body.expires_in * 1000;
    return this.token;
  }
}
