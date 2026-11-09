import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { xlsx } from "./radar-fixture.js";
import { devOrgsFile, importDevOrgs, loadDevOrgs, parseDevOrgs, readDelimited, removeDevOrgs } from "../src/core/partner-dev-orgs.js";

let tmp: string;
const saved = { ...process.env };
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-devorgs-"));
  process.env.GCTK_HOME = tmp;
});
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(tmp, { recursive: true, force: true });
});

const HEADER = ["Account Name", "Opportunity Name", "Quote", "CCDB Name", "Billing Category", "Subscription Start Date", "Subscription End Date", "Product Name", "Part Number", "Total Discount", "Org ID", "AWS Region", "Blank"];
const row = (account: string, part: string, org: string, region = "eu-central-1", start = "22/05/2026 00:00:00", end = "21/05/2031 00:00:00", opportunity = "Partner dev lab") =>
  [account, opportunity, "2026-1", "S-1", "Annual Pre-Pay", start, end, `Bundle ${part}`, part, "100", org, region, ""];

/** The report as Salesforce exports it: UTF-16 LE with BOM, tabs, a quoted field with a line break. */
function report(rows: string[][]): Buffer {
  const text = [HEADER, ...rows].map((r) => r.map((c) => (/[\t\n"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join("\t")).join("\r\n");
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

const ROWS = [
  row("Alpha GmbH", "GC-170-DEV-LABBUP", "org-a1", "eu-central-1", "01/03/2027 00:00:00", "29/02/2028 00:00:00"),
  row("Alpha GmbH", "PC-170-DEV-PARTNERLABBUBYOC", "org-a2", "eu-west-1"),
  row("Beta Ltd", "PC-170-DEV-PARTNERLABBUPCV", "org-b1", "us-east-1", "13/08/2023 00:00:00", "12/08/2028 00:00:00", 'Cloud Renewal - "Beta" -\nS-0166574: Cloned'),
  row("Beta Ltd", "PC-170-NV-PARTNERLABBUVIR", "org-b1", "us-east-1", "10/08/2023 00:00:00", "12/09/2028 00:00:00"),
  row("Gamma Inc", "GC-170-DEV-LABBUC", "org-c1", "us-west-2"),
  row("Gamma Inc", "gc-170-dev-labbuv", "org-c2", "us-west-2"),
  row("Delta", "GCFR-170-DEV-LABBUP", "org-d1", "us-east-2"),
];

describe("partner dev orgs", () => {
  it("reads quoted fields with delimiters, quotes and line breaks", () => {
    expect(readDelimited('a,"b, ""c""\nd",e\r\nf,g,h\n')).toEqual([["a", 'b, "c"\nd', "e"], ["f", "g", "h"]]);
    expect(readDelimited("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("sorts each org into CX4 or CX3 by its part numbers, and each partner by its orgs", () => {
    const d = parseDevOrgs(report(ROWS), "/x/Partner Dev Orgs_data.csv", new Date("2026-11-09T10:00:00Z"));
    expect(d.fileName).toBe("Partner Dev Orgs_data.csv");
    expect(d.orgs.map((o) => [o.partner, o.orgId, o.generation])).toEqual([
      ["Alpha GmbH", "org-a1", "cx4"],
      ["Alpha GmbH", "org-a2", "cx3"],
      ["Beta Ltd", "org-b1", "cx3"],
      ["Delta", "org-d1", "cx3"],
      ["Gamma Inc", "org-c1", "cx4"],
      ["Gamma Inc", "org-c2", "cx4"],
    ]);
    // An org on two rows: both parts, the earliest start and the latest end.
    expect(d.orgs[2]).toMatchObject({ parts: ["PC-170-DEV-PARTNERLABBUPCV", "PC-170-NV-PARTNERLABBUVIR"], start: "2023-08-10", end: "2028-09-12", region: "us-east-1", billing: "Annual Pre-Pay" });
    expect(d.orgs[0]).toMatchObject({ start: "2027-03-01", end: "2028-02-29" });
    expect(d.partners).toEqual([
      { name: "Alpha GmbH", orgs: 2, cx4: 1, cx3: 1, status: "partly" },
      { name: "Beta Ltd", orgs: 1, cx4: 0, cx3: 1, status: "cx3" },
      { name: "Delta", orgs: 1, cx4: 0, cx3: 1, status: "cx3" },
      { name: "Gamma Inc", orgs: 2, cx4: 2, cx3: 0, status: "upgraded" },
    ]);
  });

  it("reads the same report as UTF-8 CSV and as Excel", () => {
    const csv = [HEADER, ...ROWS].map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
    expect(parseDevOrgs(Buffer.from(`\uFEFF${csv}`)).partners.map((p) => p.status)).toEqual(["partly", "cx3", "cx3", "upgraded"]);
    const excel = parseDevOrgs(xlsx([HEADER, ...ROWS.map((r) => r.map((c, i) => (i === 5 ? 46082 : c)))]));
    expect(excel.partners.map((p) => p.status)).toEqual(["partly", "cx3", "cx3", "upgraded"]);
    expect(excel.orgs[1]!.start).toBe("2026-03-01");
  });

  it("refuses files that are not the report", () => {
    expect(() => parseDevOrgs(Buffer.from("Name,Score\nx,1"))).toThrow(/"Account Name", "Org ID", "Part Number"/);
    expect(() => parseDevOrgs(report([]))).toThrow(/no orgs/);
  });

  it("keeps the last upload in the gctk home until it is removed", () => {
    expect(loadDevOrgs()).toBeNull();
    importDevOrgs(report(ROWS), "a.csv");
    expect(loadDevOrgs()?.orgs).toHaveLength(6);
    expect(fs.statSync(devOrgsFile()).mode & 0o777).toBe(0o600);
    expect(() => importDevOrgs(Buffer.from("nope"))).toThrow();
    expect(loadDevOrgs()?.fileName).toBe("a.csv");
    expect(removeDevOrgs()).toBe(true);
    expect(removeDevOrgs()).toBe(false);
    expect(loadDevOrgs()).toBeNull();
  });
});
