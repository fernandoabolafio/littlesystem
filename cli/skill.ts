import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SKILL from "../skill/SKILL.md";
import { confirm, choose, interactive } from "./prompt";

export { SKILL };

const SKILL_NAME = "littlesystem";

export interface Harness {
  id: string;
  label: string;
  /** Dot-folder in $HOME whose presence means the harness is installed. */
  marker: string;
  /** Skills folder, relative to $HOME (personal) or to the repo (project). */
  skillsDir: string;
}

export const HARNESSES: Harness[] = [
  { id: "cursor", label: "Cursor", marker: ".cursor", skillsDir: ".cursor/skills" },
  { id: "claude", label: "Claude Code", marker: ".claude", skillsDir: ".claude/skills" },
  // Codex reads ~/.agents/skills, the shared location other agents use as well.
  { id: "codex", label: "Codex and other agents", marker: ".codex", skillsDir: ".agents/skills" },
];

export function detectHarnesses(): Harness[] {
  return HARNESSES.filter((h) => fs.existsSync(path.join(os.homedir(), h.marker)));
}

export function harnessById(id: string): Harness {
  const h = HARNESSES.find((x) => x.id === id);
  if (!h) throw new Error(`unknown agent "${id}" (choose from: ${HARNESSES.map((x) => x.id).join(", ")})`);
  return h;
}

/** Writes SKILL.md into `<base>/<skillsDir>/littlesystem/`; returns the file path. */
export function installSkill(harness: Harness, base: string): string {
  return installSkillInto(path.join(base, harness.skillsDir, SKILL_NAME));
}

export function installSkillInto(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, SKILL);
  return file;
}

/** Interactive offer used by `init` and the first `project new`. Returns the files written. */
export async function offerSkill(): Promise<string[]> {
  if (!interactive()) return [];
  const detected = detectHarnesses();
  let targets: Harness[];
  if (detected.length) {
    const names = detected.map((h) => h.label).join(", ");
    const yes = await confirm(
      `Install the littlesystem skill so your coding agent knows how to build systems? (found: ${names})`,
    );
    if (!yes) return [];
    targets = detected;
  } else {
    const options = [...HARNESSES.map((h) => `${h.label} (~/${h.skillsDir})`), "Skip"];
    const i = await choose("Install the littlesystem skill for your coding agent?", options, options.length - 1);
    if (i === HARNESSES.length) return [];
    targets = [HARNESSES[i]!];
  }
  return targets.map((h) => installSkill(h, os.homedir()));
}
