import Database from "better-sqlite3";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Echo } from "../ask/types.js";
import { NullHistoryCache } from "./null-store.js";
import { canonicalRoot, repoId } from "./repo-id.js";

export interface CommitMeta {
  sha: string;
  message: string;
  author: string;
  date: string;
  ct: number;
}

export interface HistoryCache {
  getCommit(sha: string): CommitMeta | undefined;
  putCommits(commits: CommitMeta[]): void;
  getRead(key: string): unknown | undefined;
  putRead(key: string, value: unknown): void;
  getGithub(key: string, now: number, ttlMs: number): unknown | undefined;
  putGithub(key: string, value: unknown, now: number): void;
  getEcho(sha: string, inputKey: string): Echo | undefined;
  putEcho(sha: string, inputKey: string, echo: Echo): void;
  getState(key: string): string | undefined;
  putState(key: string, value: string): void;
  /** Warnings recorded since opening (every one starts with `cache:`). */
  warnings(): string[];
  close(): void;
}

/** Bump to drop and recreate every table: the cache is disposable. */
const SCHEMA_VERSION = 1;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * SQLite-backed HistoryCache. Every method catches its own errors: the first
 * failure switches the instance to no-op behaviour and records one `cache:`
 * warning, so a broken cache can never break a Question.
 */
export class SqliteHistoryCache implements HistoryCache {
  private readonly db: InstanceType<typeof Database>;
  private broken = false;
  private closed = false;
  private readonly seen: string[] = [];

  constructor(dbPath: string) {
    const db: InstanceType<typeof Database> = new Database(dbPath);
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 2000");
        this.migrateDb(db);
    } catch (error) {
      // Never leak the handle: on Windows an open file blocks temp cleanup.
      try {
        db.close();
      } catch {
        // Ignore close errors; the original failure is what matters.
      }
      throw error;
    }
    this.db = db;
  }

  private warn(message: string): void {
    this.seen.push(`cache: ${message}`);
  }

  private fail<T>(message: string, fallback: T): T {
    if (!this.broken) {
      this.broken = true;
      this.warn(message);
    }
    return fallback;
  }

  private migrateDb(db: InstanceType<typeof Database>): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version !== SCHEMA_VERSION) {
    db.exec(
      "DROP TABLE IF EXISTS commits; DROP TABLE IF EXISTS reads;" +
        " DROP TABLE IF EXISTS github; DROP TABLE IF EXISTS echoes;" +
        " DROP TABLE IF EXISTS state;",
    );
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS commits" +
      " (sha TEXT PRIMARY KEY, message TEXT, author TEXT, date TEXT, ct INTEGER);" +
      "CREATE TABLE IF NOT EXISTS reads (key TEXT PRIMARY KEY, json TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS github" +
      " (key TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS echoes" +
      " (sha TEXT PRIMARY KEY, input_key TEXT NOT NULL, json TEXT NOT NULL);" +
      "CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
  );
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

  getCommit(sha: string): CommitMeta | undefined {
    if (this.broken) return undefined;
    try {
      const row = this.db
        .prepare("SELECT sha, message, author, date, ct FROM commits WHERE sha = ?")
        .get(sha) as CommitMeta | undefined;
      return row;
    } catch (error) {
      return this.fail(`unavailable (${messageOf(error)})`, undefined);
    }
  }

  putCommits(commits: CommitMeta[]): void {
    if (this.broken || commits.length === 0) return;
    try {
      const insert = this.db.prepare(
        "INSERT OR REPLACE INTO commits (sha, message, author, date, ct) VALUES (?, ?, ?, ?, ?)",
      );
      for (const c of commits) {
        insert.run(c.sha, c.message, c.author, c.date, c.ct);
      }
    } catch (error) {
      this.fail(`unavailable (${messageOf(error)})`, undefined);
    }
  }

  getRead(key: string): unknown | undefined {
    if (this.broken) return undefined;
    try {
      const row = this.db.prepare("SELECT json FROM reads WHERE key = ?").get(key) as
        | { json: string }
        | undefined;
      return row === undefined ? undefined : (JSON.parse(row.json) as unknown);
    } catch (error) {
      return this.fail(`unavailable (${messageOf(error)})`, undefined);
    }
  }

  putRead(key: string, value: unknown): void {
    if (this.broken) return;
    try {
      this.db
        .prepare("INSERT OR REPLACE INTO reads (key, json) VALUES (?, ?)")
        .run(key, JSON.stringify(value));
    } catch (error) {
      this.fail(`unavailable (${messageOf(error)})`, undefined);
    }
  }

  getGithub(key: string, now: number, ttlMs: number): unknown | undefined {
    if (this.broken) return undefined;
    try {
      const row = this.db
        .prepare("SELECT json, fetched_at FROM github WHERE key = ?")
        .get(key) as { json: string; fetched_at: number } | undefined;
      if (row === undefined || now - row.fetched_at >= ttlMs) {
        return undefined;
      }
      return JSON.parse(row.json) as unknown;
    } catch (error) {
      return this.fail(`unavailable (${messageOf(error)})`, undefined);
    }
  }

  putGithub(key: string, value: unknown, now: number): void {
    if (this.broken) return;
    try {
      this.db
        .prepare("INSERT OR REPLACE INTO github (key, json, fetched_at) VALUES (?, ?, ?)")
        .run(key, JSON.stringify(value), now);
    } catch (error) {
      this.fail(`unavailable (${messageOf(error)})`, undefined);
    }
  }

  getEcho(sha: string, inputKey: string): Echo | undefined {
    if (this.broken) return undefined;
    try {
      const row = this.db
        .prepare("SELECT input_key, json FROM echoes WHERE sha = ?")
        .get(sha) as { input_key: string; json: string } | undefined;
      if (row === undefined || row.input_key !== inputKey) {
        return undefined;
      }
      return JSON.parse(row.json) as Echo;
    } catch (error) {
      return this.fail(`unavailable (${messageOf(error)})`, undefined);
    }
  }

  putEcho(sha: string, inputKey: string, echo: Echo): void {
    if (this.broken) return;
    try {
      this.db
        .prepare("INSERT OR REPLACE INTO echoes (sha, input_key, json) VALUES (?, ?, ?)")
        .run(sha, inputKey, JSON.stringify(echo));
    } catch (error) {
      this.fail(`unavailable (${messageOf(error)})`, undefined);
    }
  }

  getState(key: string): string | undefined {
    if (this.broken) return undefined;
    try {
      const row = this.db.prepare("SELECT value FROM state WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      return row?.value;
    } catch (error) {
      return this.fail(`unavailable (${messageOf(error)})`, undefined);
    }
  }

  putState(key: string, value: string): void {
    if (this.broken) return;
    try {
      this.db.prepare("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)").run(key, value);
    } catch (error) {
      this.fail(`unavailable (${messageOf(error)})`, undefined);
    }
  }

  warnings(): string[] {
    return [...this.seen];
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.db.close();
    } catch (error) {
      if (!this.broken) {
        this.broken = true;
        this.warn(`unavailable (${messageOf(error)})`);
      }
    }
  }
}

function foldCase(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/** Like `canonicalExistingPath` in scripts: resolve what exists, keep the rest. */
function canonicalForComparison(value: string): string {
  const absolute = path.resolve(value);
  const missing: string[] = [];
  let current = absolute;
  while (true) {
    try {
      let resolved = realpathSync.native(current);
      for (let i = missing.length - 1; i >= 0; i--) {
        resolved = path.join(resolved, missing[i]!);
      }
      return foldCase(resolved);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return foldCase(absolute);
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Open `<hadesHome>/<repo-id>.db` (creating `hadesHome`). Never throws: any
 * failure, or a database path inside the repo, yields a no-op cache plus a
 * `cache:` warning. Nothing secret is ever passed to the store.
 */
export function openCache(
  repoRoot: string,
  opts: { hadesHome: string },
): { cache: HistoryCache; warning?: string } {
  const fallback = (warning: string): { cache: HistoryCache; warning?: string } => ({
    cache: new NullHistoryCache(),
    warning,
  });
  try {
    const dbPath = path.join(opts.hadesHome, `${repoId(repoRoot)}.db`);
    if (
      isInside(
        canonicalForComparison(canonicalRoot(repoRoot)),
        canonicalForComparison(dbPath),
      )
    ) {
      return fallback(`cache: unavailable (database path ${dbPath} is inside the repo)`);
    }
    mkdirSync(opts.hadesHome, { recursive: true });
    return { cache: new SqliteHistoryCache(dbPath) };
  } catch (error) {
    return fallback(`cache: unavailable (${messageOf(error)})`);
  }
}
