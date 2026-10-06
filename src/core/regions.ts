import { GctkError } from "./errors.js";

/** AWS region key -> Genesys Cloud domain. https://developer.genesys.cloud/platform/api/ */
export const REGIONS: Record<string, string> = {
  "us-east-1": "mypurecloud.com",
  "us-east-2": "use2.us-gov-pure.cloud",
  "us-west-2": "usw2.pure.cloud",
  "ca-central-1": "cac1.pure.cloud",
  "sa-east-1": "sae1.pure.cloud",
  "eu-west-1": "mypurecloud.ie",
  "eu-west-2": "euw2.pure.cloud",
  "eu-central-1": "mypurecloud.de",
  "eu-central-2": "euc2.pure.cloud",
  "me-central-1": "mec1.pure.cloud",
  "ap-south-1": "aps1.pure.cloud",
  "ap-northeast-1": "mypurecloud.jp",
  "ap-northeast-2": "apne2.pure.cloud",
  "ap-northeast-3": "apne3.pure.cloud",
  "ap-southeast-2": "mypurecloud.com.au",
};

const DOMAIN_RE = /^(?:[a-z0-9-]+\.)*(?:pure\.cloud|mypurecloud\.[a-z.]+|us-gov-pure\.cloud|inintca\.com)$/;

/**
 * Accepts an AWS region key ("eu-central-1") or a domain ("mypurecloud.de",
 * "euc1.pure.cloud", "api.mypurecloud.de") and returns the bare domain.
 */
export function resolveRegion(input: string): string {
  const value = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const known = REGIONS[value];
  if (known) return known;
  const domain = value.replace(/^(api|login|apps)\./, "");
  if (DOMAIN_RE.test(domain)) return domain;
  throw new GctkError(
    "UNKNOWN_REGION",
    `Unknown Genesys Cloud region "${input}".`,
    `Use a domain like mypurecloud.de or a region key: ${Object.keys(REGIONS).join(", ")}`,
  );
}

export const apiBase = (domain: string) => `https://api.${domain}`;
export const loginBase = (domain: string) => `https://login.${domain}`;

/** Messenger environment by org domain, used when the deployment's snippet names none. */
const ENVIRONMENTS: Record<string, string> = {
  "mypurecloud.com": "prod",
  "use2.us-gov-pure.cloud": "prod-use2",
  "usw2.pure.cloud": "prod-usw2",
  "cac1.pure.cloud": "prod-cac1",
  "sae1.pure.cloud": "prod-sae1",
  "mypurecloud.ie": "prod-euw1",
  "euw2.pure.cloud": "prod-euw2",
  "mypurecloud.de": "prod-euc1",
  "euc2.pure.cloud": "prod-euc2",
  "mec1.pure.cloud": "prod-mec1",
  "aps1.pure.cloud": "prod-aps1",
  "mypurecloud.jp": "prod-apne1",
  "apne2.pure.cloud": "prod-apne2",
  "apne3.pure.cloud": "prod-apne3",
  "mypurecloud.com.au": "prod-apse2",
};

/** The Messenger environment of an org domain (the one in Genesys' deployment snippet). */
export const environmentFor = (domain: string) => ENVIRONMENTS[domain] ?? "prod";
