import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GctkError } from "./errors.js";
import { gctkHome } from "./paths.js";

/**
 * Partner groups (UI page "Partner", tab "Dev orgs", decision 2026-11-09): named lists of partner
 * names the user wants to see the overview for, e.g. the partners of one territory. Kept apart from
 * the report (partner-groups.json in the gctk home), so a newer upload keeps them; a name that is not
 * in the report is kept and shown as such.
 */

export interface PartnerGroup {
  id: string;
  name: string;
  partners: string[];
}

const MAX_GROUPS = 100;
const MAX_PARTNERS = 5000;

export const partnerGroupsFile = () => path.join(gctkHome(), "partner-groups.json");

export function loadPartnerGroups(): PartnerGroup[] {
  try {
    const v = JSON.parse(fs.readFileSync(partnerGroupsFile(), "utf8")) as { groups?: PartnerGroup[] };
    return Array.isArray(v.groups) ? v.groups : [];
  } catch {
    return [];
  }
}

function write(groups: PartnerGroup[]): PartnerGroup[] {
  fs.mkdirSync(gctkHome(), { recursive: true });
  const tmp = `${partnerGroupsFile()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ groups }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, partnerGroupsFile());
  return groups;
}

function clean(input: Record<string, unknown>, others: PartnerGroup[]): Omit<PartnerGroup, "id"> {
  const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > 80) throw new GctkError("INVALID_INPUT", "Give the group a name (up to 80 characters).");
  if (others.some((g) => g.name.toLowerCase() === name.toLowerCase())) throw new GctkError("INVALID_INPUT", `There is a group called ${name} already.`);
  const seen = new Set<string>();
  const partners: string[] = [];
  for (const p of Array.isArray(input.partners) ? input.partners : []) {
    const s = typeof p === "string" ? p.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    if (s && !seen.has(s.toLowerCase())) (seen.add(s.toLowerCase()), partners.push(s));
  }
  if (!partners.length) throw new GctkError("INVALID_INPUT", "Choose at least one partner for the group.");
  if (partners.length > MAX_PARTNERS) throw new GctkError("INVALID_INPUT", `A group can hold up to ${MAX_PARTNERS} partners.`);
  return { name, partners: partners.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })) };
}

export function addPartnerGroup(input: Record<string, unknown>): PartnerGroup {
  const groups = loadPartnerGroups();
  if (groups.length >= MAX_GROUPS) throw new GctkError("INVALID_INPUT", `gctk keeps up to ${MAX_GROUPS} groups; delete one first.`);
  const group = { id: crypto.randomBytes(6).toString("hex"), ...clean(input, groups) };
  write([...groups, group]);
  return group;
}

export function updatePartnerGroup(id: string, input: Record<string, unknown>): PartnerGroup {
  const groups = loadPartnerGroups();
  if (!groups.some((g) => g.id === id)) throw new GctkError("NOT_FOUND", "This group no longer exists.");
  const group = { id, ...clean(input, groups.filter((g) => g.id !== id)) };
  write(groups.map((g) => (g.id === id ? group : g)));
  return group;
}

export function removePartnerGroup(id: string): void {
  const groups = loadPartnerGroups();
  if (!groups.some((g) => g.id === id)) throw new GctkError("NOT_FOUND", "This group no longer exists.");
  write(groups.filter((g) => g.id !== id));
}
