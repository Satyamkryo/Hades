import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resurrect, type ResurrectOptions } from "../src/index.js";
import { parseSummonArgs, USAGE } from "./summon-args.js";
import { recoveryLines } from "./summon-recovery.js";
import { CTRL_C_NOTE, exitCodeFor, formatSummary, reportPath } from "./summon-format.js";
import { terminateRunningCommands } from "../src/summon/process.js";

export { parseSummonArgs };

function writeLinesAndExit(lines: readonly string[], code: number): void {
  const text = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  if (text === "") {
    process.exit(code);
  }
  process.stdout.write(text, () => process.exit(code));
}

/**
 * Bound for the SIGINT path: after abort, the run and the read-only recovery
 * probe must settle fast so Ctrl+C always reaches recovery output and exit 130,
 * even if a git or filesystem wait hangs.
 */
const SIGINT_SETTLE_MS = 15_000;
const SIGINT_RECOVERY_MS = 10_000;

function withSigintTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function main(): Promise<number> {
  const args = parseSummonArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(`${args.error}\n${USAGE}`);
    return 1;
  }
  const { repo } = args;
  const options: ResurrectOptions = {};
  if (args.limit !== undefined) options.limit = args.limit;
  if (args.testCommand !== undefined) options.testCommand = args.testCommand;
  if (args.timeoutMs !== undefined) options.timeoutMs = args.timeoutMs;
  console.log(CTRL_C_NOTE);
  const controller = new AbortController();
  const run = resurrect(repo, Object.keys(options).length > 0 ? options : undefined, {
    signal: controller.signal,
  });
  // Print-only recovery: the commands are shown, never run. Exit 130 = 128 + SIGINT.
  // Every wait here is bounded so a hung git/filesystem call cannot prevent
  // recovery output and exit 130.
  process.once("SIGINT", () => {
    controller.abort();
    terminateRunningCommands()
      .then(() => withSigintTimeout(run.catch(() => undefined), SIGINT_SETTLE_MS, undefined))
      .then(() =>
        withSigintTimeout(recoveryLines({ repo, pid: process.pid }), SIGINT_RECOVERY_MS, []).then(
          (lines) => {
            writeLinesAndExit(lines, 130);
          },
          () => process.exit(130),
        ),
      )
      .then(
        () => undefined,
        () => process.exit(130),
      );
  });
  // No deps.llm: resurrect builds the real client from HADES_LLM_* env variables.
  const report = await run;
  if (controller.signal.aborted) return 130;
  for (const line of formatSummary(report, { testCommand: args.testCommand !== undefined })) console.log(line);

  const file = reportPath(report.repo, report.baseSha);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 2), "utf8");
  console.log(`Report: ${file}`);
  return exitCodeFor(report.status);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof Error && (err.name === "HadesAbortError" || err.name === "AbortError")) return;
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
