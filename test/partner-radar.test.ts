import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEADER, ROWS, xlsx } from "./radar-fixture.js";
import { importRadar, loadRadar, parseRadar, radarFile, readXlsx, removeRadar } from "../src/core/partner-radar.js";

let tmp: string;
const saved = { ...process.env };
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gctk-radar-"));
  process.env.GCTK_HOME = tmp;
});
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Enablement Radar", () => {
  it("reads the first sheet of a workbook, wherever its rels put it", () => {
    const rows = readXlsx(xlsx([["a", 1.5], [null, "b & <c>"]]));
    expect(rows).toEqual([["a", "1.5"], ["", "b & <c>"]]);
  });

  it("turns the Forms export into topics and answers per partner", () => {
    const r = parseRadar(xlsx([HEADER, ...ROWS]), "/tmp/Checklist(1-2).xlsx", new Date("2026-11-04T10:00:00Z"));
    expect(r.fileName).toBe("Checklist(1-2).xlsx");
    expect(r.topics.map((t) => [t.id, t.kind, t.group])).toEqual([
      ["voice", "status", "Channels"],
      ["tts", "text", "Channels"],
      ["social-messaging", "choices", "Channels"],
      ["journey", "status", "Orchestration and platform"],
      ["can-a-brand-new-capability-be-demonstrat", "status", "Other"],
    ]);
    expect(r.groups).toEqual(["Channels", "Orchestration and platform", "Other"]);
    expect(r.topics[0]).toMatchObject({ label: "Voice", question: "Is the Voice demo ready?", description: "Test number, inbound flow, routing to an agent, and recording should work reliably." });

    const [a, b] = r.responses;
    expect(a).toMatchObject({ id: "7", partner: "Example Partner", email: "anna@example.com", submitted: "2026-10-19 14:52", hasOrg: "Yes", orgName: "exampledemo", region: "Frankfurt", subscription: "GC3", ready: 2, attention: 1, answered: 3 });
    expect(a!.answers).toEqual([
      { topic: "voice", status: "attention", note: "No SIP trunk & no number" },
      { topic: "tts", text: "Genesys Native" },
      { topic: "social-messaging", choices: ["Facebook", "Instagram"] },
      { topic: "journey", status: "ready" },
      { topic: "can-a-brand-new-capability-be-demonstrat", status: "ready" },
    ]);
    expect(b).toMatchObject({ partner: "Other Partner", hasOrg: "No, need help!", ready: 0, attention: 0, answered: 0 });
    expect(b!.answers[2]).toEqual({ topic: "social-messaging", choices: [], note: "No accounts yet" });
    expect(b!.answers[0]).toEqual({ topic: "voice", status: "unanswered" });
  });

  it("refuses files that are not the checklist", () => {
    expect(() => parseRadar(Buffer.from("hello"))).toThrow(/not an Excel file/);
    expect(() => parseRadar(xlsx([["Name", "Score"], ["x", 1]]))).toThrow(/Partner Name/);
    expect(() => parseRadar(xlsx([["Partner Name", "Favourite colour"], ["x", "blue"]]))).toThrow(/Ready/);
    expect(() => parseRadar(xlsx([HEADER]))).toThrow(/no answers/);
  });

  it("keeps the last upload in the gctk home until it is removed", () => {
    expect(loadRadar()).toBeNull();
    importRadar(xlsx([HEADER, ...ROWS]), "a.xlsx");
    expect(loadRadar()?.responses).toHaveLength(2);
    expect(fs.statSync(radarFile()).mode & 0o777).toBe(0o600);
    expect(() => importRadar(Buffer.from("nope"))).toThrow();
    expect(loadRadar()?.fileName).toBe("a.xlsx");
    expect(removeRadar()).toBe(true);
    expect(removeRadar()).toBe(false);
    expect(loadRadar()).toBeNull();
  });
});
