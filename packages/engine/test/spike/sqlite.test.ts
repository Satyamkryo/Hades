// Spike (task 1.2): can `better-sqlite3` open, write, read and close a
// database on this machine (Windows, Node 24)? The file lives in the OS temp
// directory and is deleted afterwards, so nothing leaks into the repo.
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

describe("spike: better-sqlite3 on Windows", () => {
  it("open/write/read/close/delete in os.tmpdir()", () => {
    const dbPath = join(tmpdir(), `hades-spike-${randomUUID()}.db`);
    const sidecars = [`${dbPath}-wal`, `${dbPath}-shm`];
    try {
      const db = new Database(dbPath);
      try {
        const journalMode = (db.pragma("journal_mode = WAL", { simple: true }) as unknown) as string;
        expect(journalMode.toLowerCase()).toBe("wal");

        db.exec("CREATE TABLE spike (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
        db.prepare("INSERT INTO spike (id, value) VALUES (?, ?)").run(1, "ember");

        const row = db.prepare("SELECT value FROM spike WHERE id = ?").get(1) as { value: string };
        expect(row.value).toBe("ember");
      } finally {
        db.close();
      }
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      for (const f of [dbPath, ...sidecars]) {
        rmSync(f, { force: true });
      }
    }
    expect(existsSync(dbPath)).toBe(false);
    for (const f of sidecars) {
      expect(existsSync(f)).toBe(false);
    }
  });
});
