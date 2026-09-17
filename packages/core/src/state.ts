import { readFile, writeFile } from "node:fs/promises";

/** A responsive variant Strapi generated for an uploaded image. */
export interface MediaFormat {
  url: string;
  width: number;
}

/**
 * Simple resumable state: WP id -> Strapi documentId mappings.
 * Keeps migrations idempotent and recoverable after a crash.
 */
export interface MigrationState {
  media: Record<
    number,
    { strapiId: number; url: string; sourceUrl: string; formats?: MediaFormat[] }
  >;
  posts: Record<number, { documentId: string }>;
  pages: Record<number, { documentId: string }>;
}

const EMPTY: MigrationState = { media: {}, posts: {}, pages: {} };

export class StateStore {
  private state: MigrationState = structuredClone(EMPTY);
  private dirty = false;
  /** Serializes writes so a save started earlier can never clobber a later one. */
  private chain: Promise<void> = Promise.resolve();

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

  setMedia(
    wpId: number,
    strapiId: number,
    url: string,
    sourceUrl: string,
    formats?: MediaFormat[],
  ): void {
    this.state.media[wpId] = { strapiId, url, sourceUrl, formats };
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

  /**
   * Persist the state — call liberally. Writes are queued rather than dropped: concurrent
   * callers collapse into the next write, and that write always serializes the latest state.
   */
  async persist(): Promise<void> {
    if (!this.dirty) return this.chain;
    this.chain = this.chain.then(() => this.write());
    return this.chain;
  }

  private async write(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await writeFile(this.path, JSON.stringify(this.state, null, 2), "utf8");
    } catch (err) {
      this.dirty = true;
      throw err;
    }
  }
}
