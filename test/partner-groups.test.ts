import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addPartnerGroup, loadPartnerGroups, partnerGroupsFile, removePartnerGroup, updatePartnerGroup } from "../src/core/partner-groups.js";

let tmp: string;
const saved = { ...process.env };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-groups-"));
  process.env.GCTK_HOME = tmp;
});
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("partner groups", () => {
  it("adds, edits and deletes groups, with clean partner names", () => {
    expect(loadPartnerGroups()).toEqual([]);
    const g = addPartnerGroup({ name: "  DACH  partners ", partners: ["Zeta GmbH", " acme  AG", "Acme AG", "", 7] });
    expect(g).toMatchObject({ name: "DACH partners", partners: ["acme AG", "Zeta GmbH"] });
    expect(fs.statSync(partnerGroupsFile()).mode & 0o777).toBe(0o600);

    const other = addPartnerGroup({ name: "Nordics", partners: ["Norse AS"] });
    expect(() => addPartnerGroup({ name: "dach PARTNERS", partners: ["x"] })).toThrow(/already/);
    expect(() => addPartnerGroup({ name: "Empty", partners: [] })).toThrow(/at least one partner/);
    expect(() => addPartnerGroup({ name: "", partners: ["x"] })).toThrow(/name/);

    const edited = updatePartnerGroup(g.id, { name: "DACH", partners: ["Acme AG"] });
    expect(edited).toEqual({ id: g.id, name: "DACH", partners: ["Acme AG"] });
    expect(() => updatePartnerGroup(other.id, { name: "dach", partners: ["x"] })).toThrow(/already/);
    expect(updatePartnerGroup(g.id, { name: "DACH", partners: ["Acme AG", "Beta"] }).partners).toEqual(["Acme AG", "Beta"]);

    removePartnerGroup(g.id);
    expect(loadPartnerGroups().map((x) => x.name)).toEqual(["Nordics"]);
    expect(() => removePartnerGroup(g.id)).toThrow(/no longer exists/);
  });
});
