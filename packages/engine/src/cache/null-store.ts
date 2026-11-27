import type { Echo } from "../ask/types.js";
import type { HistoryCache } from "./store.js";

/** No-op cache: every read misses, every write is dropped. Used on any error. */
export class NullHistoryCache implements HistoryCache {
  getCommit(): undefined {
    return undefined;
  }
  putCommits(): void {}
  getRead(): undefined {
    return undefined;
  }
  putRead(): void {}
  getGithub(): undefined {
    return undefined;
  }
  putGithub(): void {}
  getEcho(): undefined {
    return undefined;
  }
  putEcho(_sha: string, _inputKey: string, _echo: Echo): void {}
  getState(): undefined {
    return undefined;
  }
  putState(): void {}
  warnings(): string[] {
    return [];
  }
  close(): void {}
}
