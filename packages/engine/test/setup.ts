import fc from "fast-check";
import { afterAll } from "vitest";
import { leakedTemps } from "../src/summon/temp-registry.js";

// A failing property prints its seed, path and counterexample, so it can be replayed with
// `fc.assert(prop, { seed, path })`. Verbose also prints every failing attempt.
fc.configureGlobal({ verbose: true });

// Fail the file if a temp folder created by this process is still there at the end.
// Only paths registered in this process are checked; other processes are never inspected.
afterAll(() => {
  const leaked = leakedTemps();
  if (leaked.length > 0) {
    throw new Error(`temp folders created by this test file were not removed:\n${leaked.join("\n")}`);
  }
});
