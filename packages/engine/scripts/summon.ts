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
  process.once("SIGINT", () => {
    controller.abort();
    terminateRunningCommands().then(() => run.catch(() => undefined)).then(() =>
      recoveryLines({ repo, pid: process.pid }).then(
        (lines) => {
          writeLinesAndExit(lines, 130);
        },
        () => process.exit(130),
      ),
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
    if (err instanceof Error && err.name === "AbortError") return;
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
