import { spawn, type ChildProcess } from "node:child_process";
import { HadesAbortError } from "../errors.js";

export interface RunResult {
  code: number | null;
  timedOut: boolean;
  spawnError?: string;
  output: string;
  durationMs: number;
}

export interface RunOptions {
  timeoutMs: number;
  excerptChars: number;
  /** When aborted, the process tree is killed and the promise rejects with HadesAbortError. */
  signal?: AbortSignal;
}

const KILL_GRACE_MS = 5000;
const activeChildren = new Set<ChildProcess>();

/** Kill the child and all its descendants. */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      // /T = include child processes, /F = force.
      const k = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      k.on("error", () => {});
    } else {
      // Negative pid signals the whole process group (child is its leader via `detached`).
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
}

function closeChildStreams(child: ChildProcess): void {
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
  child.unref();
}

/** Terminate every active command and wait briefly for each shell process to close. */
export async function terminateRunningCommands(): Promise<void> {
  const children = [...activeChildren];
  if (children.length === 0) return;
  for (const child of children) {
    if (child.pid !== undefined) killTree(child.pid);
  }
  await Promise.race([
    Promise.all(children.map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("close", () => resolve());
    }))),
    new Promise<void>((resolve) => setTimeout(resolve, KILL_GRACE_MS)),
  ]);
}

export function envWithoutLlmKey(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, CI: "true" };
  for (const name of Object.keys(env)) {
    const key = platform === "win32" ? name.toUpperCase() : name;
    if (key === "HADES_LLM_API_KEY" || key === "GIT_DIR" || key === "GIT_WORK_TREE") {
      delete env[name];
    }
  }
  return env;
}

/** Run a shell command line with a timeout; keeps only the last `excerptChars` of output. */
export function runCommand(cmd: string, cwd: string, opts: RunOptions): Promise<RunResult> {
  const start = Date.now();
  const env = envWithoutLlmKey(process.env);
  if (opts.signal?.aborted) return Promise.reject(new HadesAbortError());

  return new Promise<RunResult>((resolve, reject) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let abortTimer: NodeJS.Timeout | undefined;
    let spawnError: string | undefined;

    const cleanupAbort = (): void => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (abortTimer) clearTimeout(abortTimer);
    };

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      cleanupAbort();
      const result: RunResult = { code, timedOut, output, durationMs: Date.now() - start };
      if (spawnError !== undefined) result.spawnError = spawnError;
      resolve(result);
    };

    const failAbort = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      cleanupAbort();
      reject(new HadesAbortError());
    };

    let child: ChildProcess | undefined;

    const onAbort = (): void => {
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      try {
        if (child?.pid !== undefined) killTree(child.pid);
      } catch {
        // Already gone.
      }
      // Give the shell a moment to close, then reject even if it lingers.
      abortTimer = setTimeout(() => {
        if (child) {
          activeChildren.delete(child);
          closeChildStreams(child);
          try {
            child.kill("SIGKILL");
          } catch {
            // Streams already closed.
          }
        }
        failAbort();
      }, KILL_GRACE_MS);
    };

    const append = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.length > opts.excerptChars) {
        output = opts.excerptChars > 0 ? output.slice(-opts.excerptChars) : "";
      }
    };

    try {
      child = spawn(cmd, {
        cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
        env,
      });
      activeChildren.add(child);
    } catch (e) {
      spawnError = e instanceof Error ? e.message : String(e);
      finish(null);
      return;
    }

    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (e) => {
      if (opts.signal?.aborted) {
        failAbort();
        return;
      }
      spawnError = e.message;
      finish(null);
    });
    child.on("exit", () => {
      if (child?.pid !== undefined) killTree(child.pid);
    });
    child.on("close", (code) => {
      if (child) activeChildren.delete(child);
      if (opts.signal?.aborted) {
        failAbort();
        return;
      }
      finish(code);
    });

    timer = setTimeout(() => {
      timedOut = true;
      if (child?.pid !== undefined) killTree(child.pid);
      graceTimer = setTimeout(() => {
        if (child && child.exitCode === null && child.signalCode === null) {
          spawnError = `process did not terminate within ${KILL_GRACE_MS}ms after timeout`;
        }
        if (child) {
          activeChildren.delete(child);
          closeChildStreams(child);
          try {
            child.kill("SIGKILL");
          } catch {
            // The streams are already closed; preserve the termination failure as spawnError.
          }
        }
        finish(null);
      }, KILL_GRACE_MS);
    }, opts.timeoutMs);
  });
}
