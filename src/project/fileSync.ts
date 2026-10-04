import { PageRecordType, type Editor, type TLPageId } from "tldraw";
import { applyToPage, readPage } from "./canvas";
import { parseProject, parseProjectText, serializeProject } from "./format";
import type { ProjectInfo, ServerEvent } from "./protocol";

const SAVE_DEBOUNCE = 300;
const SENT_MEMORY = 20;
const DEFAULT_PAGE_NAME = /^Page \d+$/;

export interface PageStatus {
  slug?: string;
  path?: string;
  saving: boolean;
  error?: string;
  connected: boolean;
}

/**
 * Keeps tldraw pages and project files in step: one page per registered project. Changes made
 * on the canvas are written back to the file; changes made on disk (CLI, agents, editors) are
 * merged into the page as "remote" changes, so they never echo back as saves.
 */
export class FileSync {
  private slugByPage = new Map<TLPageId, string>();
  private pageBySlug = new Map<string, TLPageId>();
  private paths = new Map<string, string>();
  /** Last text known to be on disk, per project. */
  private synced = new Map<string, string>();
  /** Texts this tab wrote that the server hasn't echoed back yet, oldest first. */
  private sent = new Map<string, string[]>();
  private visited = new Set<TLPageId>();
  /** Project page the user was last on; new pages get their file next to it. */
  private lastSlug: string | undefined;
  private fileErrors = new Map<string, string>();
  private saveErrors = new Map<string, string>();
  private adopting = new Set<TLPageId>();
  private inFlight = 0;
  private connected = false;
  private initialized = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private events: EventSource;
  private disposers: (() => void)[] = [];
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(private editor: Editor) {
    this.events = new EventSource("/api/events");
    this.events.onopen = () => this.setConnected(true);
    this.events.onerror = () => this.setConnected(false);
    this.events.onmessage = (e) => this.onEvent(JSON.parse(e.data as string) as ServerEvent);
    this.disposers.push(
      editor.store.listen(() => this.scheduleSave(), { source: "user", scope: "document" }),
      editor.sideEffects.registerAfterChangeHandler("instance", (prev, next) => {
        if (prev.currentPageId !== next.currentPageId) this.onPageChange();
      }),
    );
  }

  dispose() {
    this.events.close();
    clearTimeout(this.saveTimer);
    for (const d of this.disposers) d();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  getStatus(): PageStatus {
    const slug = this.slugByPage.get(this.editor.getCurrentPageId());
    return {
      slug,
      path: slug ? this.paths.get(slug) : undefined,
      saving: this.inFlight > 0 || this.saveTimer !== undefined,
      error: slug ? (this.fileErrors.get(slug) ?? this.saveErrors.get(slug)) : undefined,
      connected: this.connected,
    };
  }

  private changed() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private setConnected(connected: boolean) {
    if (this.connected === connected) return;
    this.connected = connected;
    this.changed();
  }

  private map(pageId: TLPageId, slug: string) {
    this.slugByPage.set(pageId, slug);
    this.pageBySlug.set(slug, pageId);
    if (this.editor.getCurrentPageId() === pageId) this.trackCurrent(slug);
  }

  /** Remembers the project on screen and mirrors it in the URL (`?p=slug`), for reloads. */
  private trackCurrent(slug: string) {
    this.lastSlug = slug;
    const url = new URL(location.href);
    url.searchParams.set("p", slug);
    history.replaceState(null, "", url);
  }

  private unmap(slug: string) {
    const pageId = this.pageBySlug.get(slug);
    if (pageId) this.slugByPage.delete(pageId);
    this.pageBySlug.delete(slug);
    this.synced.delete(slug);
    this.sent.delete(slug);
    this.fileErrors.delete(slug);
    this.saveErrors.delete(slug);
  }

  private onEvent(event: ServerEvent) {
    if (event.type === "snapshot") this.onSnapshot(event.projects);
    else if (event.type === "project") this.upsert(event.project);
    else this.onRemoved(event.slug);
    this.changed();
  }

  private onSnapshot(projects: ProjectInfo[]) {
    const editor = this.editor;
    for (const p of projects) this.upsert(p);
    const live = new Set(projects.map((p) => p.slug));
    for (const slug of [...this.pageBySlug.keys()]) if (!live.has(slug)) this.onRemoved(slug);
    if (this.initialized) return;
    this.initialized = true;

    // Whatever tldraw created on boot ("Page 1") either becomes the first project or goes away.
    const strays = editor.getPages().filter((p) => !this.slugByPage.has(p.id));
    if (projects.length === 0) {
      for (const page of strays) {
        this.remote(() => editor.renamePage(page.id, "My system"));
        this.adopt(page.id);
      }
    } else {
      this.remote(() => {
        const wanted = new URLSearchParams(location.search).get("p");
        const first = this.pageBySlug.get(wanted ?? "") ?? this.pageBySlug.get(projects[0]!.slug)!;
        editor.setCurrentPage(first);
        for (const page of strays) editor.deletePage(page.id);
      });
    }
    this.onPageChange();
  }

  private upsert(p: ProjectInfo) {
    const editor = this.editor;
    this.paths.set(p.slug, p.path);
    if (p.error || p.text === undefined) {
      this.fileErrors.set(p.slug, p.error ?? "unreadable project file");
      if (!this.pageBySlug.has(p.slug)) this.createPage(p.slug, p.name);
      return;
    }
    this.fileErrors.delete(p.slug);
    // Echoes of our own saves arrive in order; an older one, overtaken by edits since, would
    // undo those edits if applied.
    const own = this.sent.get(p.slug) ?? [];
    const echo = own.indexOf(p.text);
    if (echo >= 0) {
      own.splice(0, echo + 1);
      return;
    }
    if (this.synced.get(p.slug) === p.text) return;

    let project;
    try {
      project = parseProjectText(p.text);
    } catch (e) {
      this.fileErrors.set(p.slug, (e as Error).message);
      return;
    }
    let pageId = this.pageBySlug.get(p.slug);
    if (!pageId) {
      // A page we asked the server to create may be announced before our request returns.
      const pending = [...this.adopting].find((id) => editor.getPage(id)?.name === project.name);
      if (pending) {
        this.adopting.delete(pending);
        this.map(pending, p.slug);
        pageId = pending;
      } else {
        pageId = this.createPage(p.slug, project.name);
      }
    }
    const target = pageId;
    this.remote(() => {
      if (editor.getPage(target)?.name !== project.name) editor.renamePage(target, project.name);
      applyToPage(editor, target, project);
    });
    this.synced.set(p.slug, p.text);
    this.saveErrors.delete(p.slug);
  }

  private createPage(slug: string, name: string): TLPageId {
    const id = PageRecordType.createId(slug);
    this.remote(() => {
      if (!this.editor.getPage(id)) this.editor.createPage({ id, name });
    });
    this.map(id, slug);
    return id;
  }

  private onRemoved(slug: string) {
    const pageId = this.pageBySlug.get(slug);
    this.unmap(slug);
    if (pageId && this.editor.getPages().length > 1) {
      this.remote(() => this.editor.deletePage(pageId));
    }
  }

  private remote(fn: () => void) {
    this.editor.store.mergeRemoteChanges(fn);
  }

  private onPageChange() {
    const pageId = this.editor.getCurrentPageId();
    const slug = this.slugByPage.get(pageId);
    if (slug) this.trackCurrent(slug);
    if (!this.visited.has(pageId)) {
      this.visited.add(pageId);
      this.editor.zoomToFit();
    }
    this.changed();
  }

  /** A page with no project behind it (the user added one): create a file for it. */
  private adopt(pageId: TLPageId) {
    if (this.adopting.has(pageId)) return;
    const page = this.editor.getPage(pageId);
    if (!page) return;
    this.adopting.add(pageId);
    const near = this.lastSlug ?? [...this.pageBySlug.keys()][0];
    this.request("POST", "/api/projects", { name: page.name, near })
      .then((entry) => {
        if (!this.adopting.delete(pageId)) return;
        const { slug } = entry as { slug: string };
        this.map(pageId, slug);
        this.scheduleSave();
      })
      .catch(() => this.adopting.delete(pageId));
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, SAVE_DEBOUNCE);
    this.changed();
  }

  private flush() {
    const editor = this.editor;
    const pageIds = new Set(editor.getPages().map((p) => p.id));

    for (const [pageId, slug] of [...this.slugByPage]) {
      if (pageIds.has(pageId)) continue;
      this.unmap(slug);
      void this.request("DELETE", `/api/projects/${encodeURIComponent(slug)}`).catch(() => {});
    }

    for (const page of editor.getPages()) {
      const slug = this.slugByPage.get(page.id);
      if (!slug) {
        // tldraw names new pages "Page N" and opens a rename box; wait for a real name (or
        // some content) so the file gets named after it.
        const untouched = DEFAULT_PAGE_NAME.test(page.name) && editor.getPageShapeIds(page.id).size === 0;
        if (this.initialized && !untouched) this.adopt(page.id);
        continue;
      }
      // Never overwrite a file we couldn't read: it may hold someone's half-finished edit.
      if (this.fileErrors.has(slug)) continue;
      let text: string;
      try {
        text = serializeProject(parseProject(readPage(editor, page.id, page.name)));
        this.saveErrors.delete(slug);
      } catch (e) {
        this.saveErrors.set(slug, `not saved: ${(e as Error).message}`);
        continue;
      }
      if (this.synced.get(slug) === text) continue;
      this.synced.set(slug, text);
      this.remember(slug, text);
      this.request("PUT", `/api/projects/${encodeURIComponent(slug)}`, JSON.parse(text) as unknown)
        .then(() => this.saveErrors.delete(slug))
        .catch((e: Error) => {
          this.synced.delete(slug);
          this.saveErrors.set(slug, `not saved: ${e.message}`);
        })
        .finally(() => this.changed());
    }
    this.changed();
  }

  private remember(slug: string, text: string) {
    const texts = this.sent.get(slug) ?? [];
    texts.push(text);
    if (texts.length > SENT_MEMORY) texts.shift();
    this.sent.set(slug, texts);
  }

  private async request(method: string, url: string, body?: unknown): Promise<unknown> {
    this.inFlight++;
    this.changed();
    try {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      return json;
    } finally {
      this.inFlight--;
      this.changed();
    }
  }
}

/** True when the app is being served by the littlesystem CLI (or `pnpm dev`) rather than as a static site. */
export async function hasLocalServer(): Promise<boolean> {
  try {
    const res = await fetch("/api/health", { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { app?: string };
    return body.app === "littlesystem";
  } catch {
    return false;
  }
}
