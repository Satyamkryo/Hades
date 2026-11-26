import { lstatSync } from "node:fs";

// Temp folders created by THIS process (hades-summon-*, hades-patch-*, and the test
// helpers' hades-test-repo-*). Tests use it to prove that nothing was left behind. It only
// remembers paths this process made; it never scans the OS temp dir and never deletes.
const created = new Set<string>();

export function registerTemp(p: string): void {
  created.add(p);
}

/** Registered paths that still exist (a dangling link counts as existing). */
export function leakedTemps(): string[] {
  return [...created].filter((p) => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  });
}
