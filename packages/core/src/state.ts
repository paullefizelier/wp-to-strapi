import { access, constants, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
  categories: Record<number, { documentId: string }>;
  tags: Record<number, { documentId: string }>;
  /** Custom post types, keyed by their REST base. */
  custom: Record<string, Record<number, { documentId: string }>>;
  /**
   * Any other taxonomy (custom taxonomies, authors), keyed by its REST base then WP id.
   * `categories` and `tags` keep their own buckets above for backwards compatibility.
   */
  terms: Record<string, Record<number, { documentId: string }>>;
  /** Old WordPress URL → what it became, for the redirect table. */
  redirects: Array<{ from: string; slug: string; kind: string; documentId: string }>;
  /**
   * Entries that failed, keyed by kind then WordPress id. Kept so a run can report them at the
   * end and so the next one can retry just those instead of the whole site.
   */
  failures: Record<string, Record<number, { message: string; at: string }>>;
  /**
   * AI answers by `<kind>:<wpId>`, with the key of the request that produced them: the same
   * entry asked the same thing is not paid for twice.
   */
  ai: Record<string, { key: string; values: Record<string, unknown> }>;
}

const EMPTY: MigrationState = {
  media: {},
  posts: {},
  pages: {},
  categories: {},
  tags: {},
  custom: {},
  terms: {},
  redirects: [],
  failures: {},
  ai: {},
};

export class StateStore {
  private state: MigrationState = structuredClone(EMPTY);
  private dirty = false;
  /** Serializes writes so a save started earlier can never clobber a later one. */
  private chain: Promise<void> = Promise.resolve();

  /**
   * A read-only store (dry runs) keeps every change in memory — so the end-of-run report still
   * lists failures — but never touches the file: a rehearsal must leave no trace.
   */
  constructor(
    private readonly path: string,
    private readonly opts: { readOnly?: boolean } = {},
  ) {}

  /**
   * Fail before anything is migrated when the state file can't be written: losing it mid-run
   * would make the next run duplicate every entry already sent to Strapi.
   */
  async assertWritable(): Promise<void> {
    if (this.opts.readOnly) return;
    try {
      await access(this.path, constants.W_OK);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw stateFileError(this.path, e);
      try {
        await access(dirname(this.path), constants.W_OK);
      } catch (dirErr) {
        throw stateFileError(this.path, dirErr as NodeJS.ErrnoException);
      }
    }
  }

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

  /** `categories` and `tags` keep dedicated buckets; anything else lands under `terms`. */
  setTerm(taxonomy: string, wpId: number, documentId: string): void {
    const bucket =
      taxonomy === "categories" || taxonomy === "tags"
        ? this.state[taxonomy]
        : (this.state.terms[taxonomy] ??= {});
    bucket[wpId] = { documentId };
    this.dirty = true;
  }

  /** Read a taxonomy bucket by name, wherever it lives. */
  termBucket(taxonomy: string): Record<number, { documentId: string }> {
    if (taxonomy === "categories") return this.state.categories;
    if (taxonomy === "tags") return this.state.tags;
    return this.state.terms[taxonomy] ?? {};
  }

  addRedirect(from: string, slug: string, kind: string, documentId: string): void {
    if (!from) return;
    if (this.state.redirects.some((r) => r.from === from)) return;
    this.state.redirects.push({ from, slug, kind, documentId });
    this.dirty = true;
  }

  setCustom(restBase: string, wpId: number, documentId: string): void {
    const bucket = (this.state.custom[restBase] ??= {});
    bucket[wpId] = { documentId };
    this.dirty = true;
  }

  recordFailure(kind: string, wpId: number, message: string): void {
    const bucket = (this.state.failures[kind] ??= {});
    bucket[wpId] = { message, at: new Date().toISOString() };
    this.dirty = true;
  }

  /** A retried entry that now succeeds should stop being reported. */
  clearFailure(kind: string, wpId: number): void {
    const bucket = this.state.failures[kind];
    if (bucket?.[wpId]) {
      delete bucket[wpId];
      if (Object.keys(bucket).length === 0) delete this.state.failures[kind];
      this.dirty = true;
    }
  }

  aiAnswer(entry: string, key: string): Record<string, unknown> | undefined {
    const hit = this.state.ai?.[entry];
    return hit && hit.key === key ? hit.values : undefined;
  }

  setAiAnswer(entry: string, key: string, values: Record<string, unknown>): void {
    (this.state.ai ??= {})[entry] = { key, values };
    this.dirty = true;
  }

  failedIds(kind: string): number[] {
    return Object.keys(this.state.failures[kind] ?? {}).map(Number);
  }

  allFailures(): Array<{ kind: string; wpId: number; message: string }> {
    return Object.entries(this.state.failures).flatMap(([kind, bucket]) =>
      Object.entries(bucket).map(([wpId, f]) => ({ kind, wpId: Number(wpId), message: f.message })),
    );
  }

  /**
   * Persist the state — call liberally. Writes are queued rather than dropped: concurrent
   * callers collapse into the next write, and that write always serializes the latest state.
   */
  async persist(): Promise<void> {
    if (this.opts.readOnly || !this.dirty) return this.chain;
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
      throw stateFileError(this.path, err as NodeJS.ErrnoException);
    }
  }
}

function stateFileError(path: string, err: NodeJS.ErrnoException): Error {
  const readOnlyFs = err.code === "EROFS";
  return new Error(
    `Cannot write the state file "${path}" (${err.code ?? err.message}).` +
      (readOnlyFs
        ? " The filesystem is read-only (serverless hosting such as Vercel):" +
          " run the migration where it can write, e.g. locally."
        : " Choose a path the process can write to."),
  );
}
