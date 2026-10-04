import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  emptyProject,
  looksLikeProject,
  parseProjectText,
  ProjectError,
  serializeProject,
  slugify,
  type Project,
} from "../src/project/format";

/** Folder name used for projects that live next to the user's code. */
export const LOCAL_DIR = "littlesystem";

export function homeDir(): string {
  return process.env.LITTLESYSTEM_HOME ?? path.join(os.homedir(), ".littlesystem");
}
export const globalProjectsDir = () => path.join(homeDir(), "projects");
export const registryPath = () => path.join(homeDir(), "projects.json");
export const serverInfoPath = () => path.join(homeDir(), "server.json");
export const serverLogPath = () => path.join(homeDir(), "server.log");

export interface RegistryEntry {
  slug: string;
  path: string;
}

export interface Registry {
  current?: string;
  skillOffered?: boolean;
  projects: RegistryEntry[];
}

export interface ProjectRecord extends RegistryEntry {
  text?: string;
  project?: Project;
  error?: string;
}

export function writeFileAtomic(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function readRegistry(): Registry {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(), "utf8")) as Partial<Registry>;
    return { ...raw, projects: Array.isArray(raw.projects) ? raw.projects : [] };
  } catch {
    return { projects: [] };
  }
}

export function writeRegistry(registry: Registry) {
  writeFileAtomic(registryPath(), JSON.stringify(registry, null, 2) + "\n");
}

export function updateRegistry(fn: (r: Registry) => void): Registry {
  const registry = readRegistry();
  fn(registry);
  writeRegistry(registry);
  return registry;
}

export function readProjectFile(file: string): { text: string; project: Project } {
  const text = fs.readFileSync(file, "utf8");
  return { text, project: parseProjectText(text) };
}

export function readRecord(entry: RegistryEntry): ProjectRecord {
  try {
    return { ...entry, ...readProjectFile(entry.path) };
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    return { ...entry, error: missing ? `file not found: ${entry.path}` : (e as Error).message };
  }
}

export function listProjects(): ProjectRecord[] {
  return readRegistry().projects.map(readRecord);
}

export function getEntry(slug: string): RegistryEntry | undefined {
  return readRegistry().projects.find((p) => p.slug === slug);
}

export function saveProject(entry: RegistryEntry, project: Project): string {
  const text = serializeProject(project);
  writeFileAtomic(entry.path, text);
  return text;
}

function uniqueSlug(registry: Registry, base: string): string {
  const taken = new Set(registry.projects.map((p) => p.slug));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/** Adds an existing project file to the registry (no-op if it's already there). */
export function registerProject(file: string): RegistryEntry {
  const abs = path.resolve(file);
  const existing = readRegistry().projects.find((p) => p.path === abs);
  if (existing) return existing;
  let entry: RegistryEntry | undefined;
  updateRegistry((r) => {
    entry = { slug: uniqueSlug(r, path.basename(abs, ".json")), path: abs };
    r.projects.push(entry);
  });
  return entry!;
}

export function createProject(opts: {
  name: string;
  dir: string;
  project?: Project;
}): RegistryEntry {
  const base = slugify(opts.name);
  const registry = readRegistry();
  let fileBase = base;
  let i = 2;
  while (
    fs.existsSync(path.join(opts.dir, `${fileBase}.json`)) ||
    registry.projects.some((p) => p.slug === fileBase)
  ) {
    fileBase = `${base}-${i++}`;
  }
  const file = path.join(path.resolve(opts.dir), `${fileBase}.json`);
  writeFileAtomic(file, serializeProject({ ...(opts.project ?? emptyProject(opts.name)), name: opts.name }));
  return registerProject(file);
}

export function unregisterProject(slug: string): RegistryEntry | undefined {
  let removed: RegistryEntry | undefined;
  updateRegistry((r) => {
    removed = r.projects.find((p) => p.slug === slug);
    r.projects = r.projects.filter((p) => p.slug !== slug);
    if (r.current === slug) delete r.current;
  });
  return removed;
}

/** Walks up from `cwd` looking for a `littlesystem/` folder that holds project files. */
export function findLocalProjectFiles(cwd: string): string[] {
  let dir = path.resolve(cwd);
  const home = os.homedir();
  for (;;) {
    const candidate = path.join(dir, LOCAL_DIR);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      const files = fs
        .readdirSync(candidate)
        .filter((f) => f.endsWith(".json"))
        .map((f) => path.join(candidate, f))
        .filter((f) => looksLikeProject(fs.readFileSync(f, "utf8")));
      if (files.length) return files;
    }
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) return [];
    dir = parent;
  }
}

/**
 * Which project a CLI command applies to: an explicit slug, else the project in the nearest
 * `./littlesystem/` folder, else the registry's current project.
 */
export function resolveProject(cwd: string, slug?: string): RegistryEntry {
  if (slug) {
    const entry = getEntry(slug);
    if (entry) return entry;
    if (slug.endsWith(".json") && fs.existsSync(slug)) return registerProject(slug);
    throw new ProjectError(`no project "${slug}". See \`littlesystem project list\`.`);
  }
  const local = findLocalProjectFiles(cwd).map(registerProject);
  const current = readRegistry().current;
  if (local.length === 1) return local[0]!;
  if (local.length > 1) {
    const match = local.find((e) => e.slug === current);
    if (match) return match;
    throw new ProjectError(
      `several projects here (${local.map((e) => e.slug).join(", ")}); pick one with -p <slug> or \`littlesystem project use <slug>\``,
    );
  }
  const entry = current ? getEntry(current) : undefined;
  if (entry) return entry;
  throw new ProjectError(`no project yet. Create one with: littlesystem project new "My system"`);
}
