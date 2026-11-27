import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  askHistory,
  makeNonCodeMatcher,
  makeTestFileMatcher,
  rankHaunted,
  type Echo,
  type GhIssue,
  type GhPull,
  type GithubClient,
  type HistoryAnswer,
} from "../src/index.js";
import { createGithubClient } from "../src/github/client.js";
import { gitCallCount } from "../src/git/exec.js";
import type { GithubTarget } from "../src/github/remote.js";
import { parseHistoryCheckArgs, USAGE } from "./history-check-args.js";
import { historyPath } from "./history-path.js";

export { parseHistoryCheckArgs };
export { historyPath };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
}

function short(text: string, n: number): string {
  return text.length <= n ? text : `${text.slice(0, n)}...`;
}

interface RecordedGithub {
  pulls: Map<string, GhPull[]>;
  issues: Map<number, GhIssue>;
  client: GithubClient;
}

function recordingGithub(real: GithubClient): RecordedGithub {
  const pulls = new Map<string, GhPull[]>();
  const issues = new Map<number, GhIssue>();
  return {
    pulls,
    issues,
    client: {
      commitPulls: async (t: GithubTarget, sha: string) => {
        const r = await real.commitPulls(t, sha);
        if (r.ok) pulls.set(sha, r.data);
        return r;
      },
      reviewComments: (t: GithubTarget, pr: number) => real.reviewComments(t, pr),
      issue: async (t: GithubTarget, n: number) => {
        const r = await real.issue(t, n);
        if (r.ok) issues.set(n, r.data);
        return r;
      },
    },
  };
}

function sampleEcho(e: Echo): string {
  const src = e.source === undefined ? "none" : `${e.source.kind}:${e.source.ref}`;
  return `${e.sha.slice(0, 7)} ${e.confidence} [${src}] ${short(e.text.replace(/\s+/g, " "), 120)}`;
}

function checkShaExists(repo: string, sha: string): string | undefined {
  try {
    git(repo, "cat-file", "-e", `${sha}^{commit}`);
    return undefined;
  } catch {
    return `SHA ${sha} does not exist in the repo`;
  }
}

function storedMessage(repo: string, sha: string): string {
  return git(repo, "log", "-1", "--format=%B", sha).replace(/\r?\n$/, "");
}

async function main(): Promise<number> {
  const args = parseHistoryCheckArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(`${args.error}\n${USAGE}`);
    return 1;
  }
  const failures: string[] = [];
  const fail = (message: string): void => {
    failures.push(message);
  };
  const note = (ok: boolean, message: string): void => {
    console.log(`${ok ? "PASS" : "FAIL"} ${message}`);
    if (!ok) fail(message);
  };

  const headBefore = git(args.repo, "rev-parse", "HEAD").trim();
  const statusBefore = git(args.repo, "status", "--porcelain=v2");
  const askOpts = {
    ...(args.lines !== undefined ? { lines: args.lines } : {}),
    ...(args.symbol !== undefined ? { symbol: args.symbol } : {}),
  };
  console.log(`target: ${args.repo} :: ${args.file}`);
  console.log(`HEAD: ${headBefore}`);
  if (args.lines !== undefined) console.log(`lines: ${args.lines[0]},${args.lines[1]}`);
  if (args.symbol !== undefined) console.log(`symbol: ${args.symbol}`);

  const homes: string[] = [];
  const freshHome = (): string => {
    const home = mkdtempSync(path.join(tmpdir(), "hades-history-check-"));
    homes.push(home);
    return home;
  };
  const cleanup = (): void => {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  };

  interface Run {
    name: string;
    answer: HistoryAnswer;
    gitCalls: number;
    ms: number;
  }
  const runs: Run[] = [];
  try {
    const llmEnv = ["HADES_LLM_BASE_URL", "HADES_LLM_API_KEY", "HADES_LLM_MODEL"].map(
      (n) => `${n}=${process.env[n] !== undefined && process.env[n] !== "" ? "set" : "unset"}`,
    );
    console.log(`llm env: ${llmEnv.join(" ")}`);

    // Run 1: local-only, no LLM.
    {
      const home = freshHome();
      const before = gitCallCount();
      const start = Date.now();
      const answer = await askHistory(args.repo, args.file, askOpts, {
        github: null,
        llm: null,
        hadesHome: home,
      });
      runs.push({ name: "local", answer, gitCalls: gitCallCount() - before, ms: Date.now() - start });
    }

    // Run 2: LLM from the environment, GitHub off.
    if (!args.noLlm) {
      const home = freshHome();
      const before = gitCallCount();
      const start = Date.now();
      const answer = await askHistory(args.repo, args.file, askOpts, {
        github: null,
        hadesHome: home,
      });
      runs.push({ name: "llm", answer, gitCalls: gitCallCount() - before, ms: Date.now() - start });
    } else {
      console.log("run llm: skipped (--no-llm)");
    }

    // Run 3: real GitHub client (unauthenticated without a token) plus the LLM from env.
    let recorded: RecordedGithub | undefined;
    if (!args.noGithub) {
      recorded = recordingGithub(
        createGithubClient({ token: process.env["GITHUB_TOKEN"], timeoutMs: 10_000 }),
      );
      const home = freshHome();
      const before = gitCallCount();
      const start = Date.now();
      const answer = await askHistory(args.repo, args.file, askOpts, {
        github: recorded.client,
        llm: args.noLlm ? null : undefined,
        hadesHome: home,
      });
      runs.push({ name: "github", answer, gitCalls: gitCallCount() - before, ms: Date.now() - start });
    } else {
      console.log("run github: skipped (--no-github)");
    }

    // rankHaunted with defaults.
    const hauntedBefore = gitCallCount();
    const hauntedStart = Date.now();
    const haunted = await rankHaunted(args.repo);
    const hauntedCalls = gitCallCount() - hauntedBefore;
    const hauntedMs = Date.now() - hauntedStart;

    // Automatic checks.
    const atHead = new Set(
      git(args.repo, "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter((p) => p !== ""),
    );
    const isTest = makeTestFileMatcher();
    const isNonCode = makeNonCodeMatcher();

    for (const run of runs) {
      const { answer } = run;
      console.log(`--- run ${run.name}: ${answer.commits.length} commits, ${answer.echoes.length} echoes, ${run.gitCalls} git calls, ${run.ms} ms`);
      const counts = { said: 0, inferred: 0, none: 0 };
      for (const echo of answer.echoes) counts[echo.confidence] += 1;
      console.log(`echoes: said=${counts.said} inferred=${counts.inferred} none=${counts.none}`);
      answer.echoes.slice(0, 3).forEach((e, i) => console.log(`sample ${i + 1}: ${sampleEcho(e)}`));
      for (const echo of answer.echoes) {
        if (echo.confidence === "inferred") {
          console.log(`inferred full ${echo.sha.slice(0, 7)}: ${echo.text}`);
        }
      }
      if (answer.warnings.length > 0) {
        for (const w of answer.warnings) {
          if (/rate limit/i.test(w)) {
            console.log(`RATE LIMITED (${w})`);
          } else {
            console.log(`warning: ${w}`);
          }
        }
      }

      for (const commit of answer.commits) {
        const bad = checkShaExists(args.repo, commit.sha);
        note(bad === undefined, `commit ${commit.sha.slice(0, 7)} exists`);
      }
      for (const echo of answer.echoes) {
        const bad = checkShaExists(args.repo, echo.sha);
        note(bad === undefined, `echo SHA ${echo.sha.slice(0, 7)} exists`);
        if (echo.confidence === "said" && echo.source !== undefined) {
          const { kind, ref } = echo.source;
          let sourceText: string | undefined;
          if (kind === "commit-message") {
            sourceText = storedMessage(args.repo, echo.sha);
          } else if (kind === "pr-body") {
            sourceText = recorded?.pulls.get(echo.sha)?.find((p) => p.number === Number(ref))?.body;
          } else if (kind === "issue-body") {
            sourceText = recorded?.issues.get(Number(ref))?.body;
          }
          note(sourceText !== undefined, `said echo ${echo.sha.slice(0, 7)} source ${kind}:${ref} recorded`);
          if (sourceText !== undefined) {
            note(sourceText.includes(echo.text), `said echo ${echo.sha.slice(0, 7)} quotes its source verbatim`);
            note(echo.text.length <= 300, `said echo ${echo.sha.slice(0, 7)} is at most 300 chars`);
          }
        }
        if (echo.confidence === "inferred") {
          note(/\bprobably\b/i.test(echo.text), `inferred echo ${echo.sha.slice(0, 7)} contains probably`);
          note(
            echo.text.startsWith(`${echo.sha.slice(0, 7)}: `),
            `inferred echo ${echo.sha.slice(0, 7)} has the <sha7> prefix`,
          );
        }
      }
      for (const range of answer.blame) {
        const bad = checkShaExists(args.repo, range.sha);
        note(bad === undefined, `blame SHA ${range.sha.slice(0, 7)} exists`);
      }
      if (run.name === "github") {
        const mode = answer.github;
        console.log(`token: ${process.env["GITHUB_TOKEN"] ? "yes" : "no"}`);
        if (mode.mode === "github") {
          console.log(`github.requests: ${mode.requests} rateLimited: ${mode.rateLimited}`);
        } else {
          console.log("github: local-only mode");
        }
        const withPr = answer.echoes.filter((e) => e.prNumber !== undefined).length;
        const prBody = answer.echoes.filter((e) => e.source?.kind === "pr-body").length;
        const issueBody = answer.echoes.filter((e) => e.source?.kind === "issue-body").length;
        console.log(`echoes with a PR: ${withPr}; quoting pr-body: ${prBody}, issue-body: ${issueBody}`);
      }
    }

    console.log(`--- rankHaunted: ${haunted.files.length} files, ${hauntedCalls} git calls, ${hauntedMs} ms`);
    for (const f of haunted.files.slice(0, 10)) {
      console.log(`haunted: ${f.path} score=${f.score.toFixed(1)} fixes=${f.fixes} reverts=${f.reverts} churn=${f.churn}`);
      note(!isTest(f.path) && !isNonCode(f.path), `haunted file ${f.path} is a source file`);
      note(atHead.has(f.path), `haunted file ${f.path} is at HEAD`);
    }

    const headAfter = git(args.repo, "rev-parse", "HEAD").trim();
    const statusAfter = git(args.repo, "status", "--porcelain=v2");
    note(headAfter === headBefore, "dayjs HEAD unchanged");
    note(statusAfter === statusBefore, "dayjs status unchanged");

    const file = historyPath(args.repo, headBefore, new Date(), homedir());
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify(
        { target: args.repo, file: args.file, head: headBefore, runs, haunted, failures },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`History: ${file}`);
  } finally {
    cleanup();
  }

  if (failures.length > 0) {
    console.log(`RESULT: FAIL (${failures.length} failed checks)`);
    return 1;
  }
  console.log("RESULT: PASS");
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
