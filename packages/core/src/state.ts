import { readFile, writeFile } from "node:fs/promises";

/**
 * Simple resumable state: WP id -> Strapi documentId mappings.
 * Keeps migrations idempotent and recoverable after a crash.
 */
export interface MigrationState {
  media: Record<number, { strapiId: number; url: string; sourceUrl: string }>;
  posts: Record<number, { documentId: string }>;
  pages: Record<number, { documentId: string }>;
}

const EMPTY: MigrationState = { media: {}, posts: {}, pages: {} };

export class StateStore {
  private state: MigrationState = structuredClone(EMPTY);
  private dirty = false;
  private saving: Promise<void> | null = null;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<MigrationState>;
      this.state = { ...EMPTY, ...parsed };
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
    }
  }

  get(): MigrationState {
    return this.state;
  }

  setMedia(wpId: number, strapiId: number, url: string, sourceUrl: string): void {
    this.state.media[wpId] = { strapiId, url, sourceUrl };
    this.dirty = true;
  }

  setPost(wpId: number, documentId: string): void {
    this.state.posts[wpId] = { documentId };
    this.dirty = true;
  }

  setPage(wpId: number, documentId: string): void {
    this.state.pages[wpId] = { documentId };
    this.dirty = true;
  }

  /** Debounced persist — call liberally; writes are coalesced. */
  async persist(): Promise<void> {
    if (!this.dirty) return;
    if (this.saving) return this.saving;
    this.dirty = false;
    this.saving = writeFile(
      this.path,
      JSON.stringify(this.state, null, 2),
      "utf8",
    ).finally(() => {
      this.saving = null;
    });
    return this.saving;
  }
}
