/** What the local server sends the browser for each registered project. */
export interface ProjectInfo {
  slug: string;
  path: string;
  name: string;
  /** Canonical file contents; absent when the file is missing or invalid. */
  text?: string;
  error?: string;
}

export type ServerEvent =
  | { type: "snapshot"; projects: ProjectInfo[] }
  | { type: "project"; project: ProjectInfo }
  | { type: "removed"; slug: string };

export interface Health {
  app: "littlesystem";
  version: string;
  pid: number;
}
