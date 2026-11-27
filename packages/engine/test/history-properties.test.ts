import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { askHistory, type HistoryDeps } from "../src/ask/ask-history.js";
import { NO_RECORD_TEXT, type HistoryAnswer } from "../src/ask/types.js";
import { rankHaunted } from "../src/haunted/rank-haunted.js";
import { closingIssueNumbers } from "../src/history/closing-issues.js";
import { matchRules } from "../src/history/candidates.js";
import { makeNonCodeMatcher, makeTestFileMatcher } from "../src/classify/files.js";
import { ruleOrderEcho, type RuleEchoMeta } from "../src/echo/rule-order.js";
import { collectSources, type Source } from "../src/echo/sources.js";
import { parseLog } from "../src/ask/parse-log.js";
import type { GhPull } from "../src/github/types.js";
import { createFakeGithub } from "./helpers/fake-github.js";
import {
  historyRepoPlan,
  scriptHistoryCase,
  type HistoryRepoPlan,
} from "./helpers/history-arbitraries.js";
import { extraPatternCase } from "./helpers/arbitraries.js";
import { parsePropertyRuns, parsePropertyTimeoutMs } from "./helpers/property-runs.js";
import { git, makeRepo as makeRepoRaw, type TestRepo } from "./helpers/repo.js";

// History-reader correctness properties (requirements 11.1.1-5, 5.3, 5.14).
// Offline: fake GitHub and LLM clients, temp cache dirs, fixed clock.
// 5 runs by default, 20 with HADES_PROPERTY_RUNS=20.
const GIT_RUNS = { numRuns: parsePropertyRuns(process.env.HADES_PROPERTY_RUNS) };
const PROPERTY_TIMEOUT = parsePropertyTimeoutMs(process.env.HADES_PROPERTY_TIMEOUT_MS);

const createdRepos: string[] = [];
const createdHomes: string[] = [];
function makeRepo(commits: { message: string; files: Record<string, string | null> }[]): TestRepo {
  const r = makeRepoRaw(commits);
  createdRepos.push(r.dir);
  return r;
}
function makeHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hades-home-"));
  createdHomes.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of createdRepos) rmSync(dir, { recursive: true, force: true });
  for (const dir of createdHomes) rmSync(dir, { recursive: true, force: true });
});

const FIXED_NOW = 1_000_000;
const CAPS = {
  maxCommits: 50,
  excerptChars: 4000,
  maxGithubRequests: 1000,
  githubTimeoutMs: 5000,
  githubTtlMs: 86_400_000,
  maxLlmChecks: 1000,
};

interface RunSetup {
  repo: TestRepo;
  plan: HistoryRepoPlan;
  shas: string[];
  storedMessage(sha: string): string;
}

function storedMessage(repo: TestRepo): (sha: string) => string {
  return (sha: string) => git(repo.dir, "log", "-1", "--format=%B", sha).replace(/\r?\n$/, "");
}

function choosePull(pulls: GhPull[]): GhPull | undefined {
  return [...pulls].sort((a, b) => Number(b.merged) - Number(a.merged) || a.number - b.number)[0];
}

function expectedSources(setup: RunSetup, sha: string, pr: GhPull | undefined): Source[] {
  const message = setup.storedMessage(sha);
  // Same shape as collectSources with the property repos' GitHub target.
  // Commits whose pulls errored have no PR source, mirroring gatherContext.
  const sources: Source[] = [{
    id: "commit",
    kind: "commit-message",
    ref: sha,
    url: `https://github.com/octo/prop/commit/${sha}`,
    text: message,
  }];
  if (pr !== undefined) {
    sources.push({ id: "pr", kind: "pr-body", ref: String(pr.number), url: pr.url, text: pr.body });
  }
  return sources;
}

function expectedMeta(setup: RunSetup, sha: string, pr: GhPull | undefined): RuleEchoMeta {
  const message = setup.storedMessage(sha);
  return {
    prNumber: pr?.number,
    issueNumbers: closingIssueNumbers(`${message}\n${pr?.body ?? ""}`),
    url: pr?.url ?? `https://github.com/octo/prop/commit/${sha}`,
  };
}

/** Answer content: everything but the diagnostic `github.requests` counter. */
function comparable(answer: HistoryAnswer): unknown {
  const { github, ...rest } = answer;
  return {
    ...rest,
    github: { ...github, requests: 0 },
    warnings: answer.warnings.filter((w) => !w.startsWith("cache:")),
  };
}

describe("history pure properties", () => {
  it("closingIssueNumbers agrees with the closing-issue rule", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        expect(closingIssueNumbers(text).length > 0).toBe(
          matchRules(text).includes("closing-issue"),
        );
      }),
      { numRuns: 100 },
    );
  });

  it("parseLog never invents a record from message text", () => {
    const marker = "HADES-prop-marker";
    const delimiter = `\x1e${marker}\n`;
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }).filter((m) => !m.includes(delimiter) && !m.includes("\0")),
        fc.string({ maxLength: 200 }).filter((p) => !p.includes("\0")),
        (message, patch) => {
          const sha = "a".repeat(40);
          const stdout =
            `${delimiter}${sha}\x00\x00author\x002024-01-01T00:00:00+00:00\x001704067200\x00${message}\n\x00${patch}\n`;
          const commits = parseLog(stdout, marker, 4000);
          expect(commits).toHaveLength(1);
          expect(commits[0]?.sha).toBe(sha);
          expect(commits[0]?.message).toBe(message.replace(/\r?\n$/, ""));
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("history properties", () => {
  it("echoes cite existing commits, verbatim quotes and marked guesses", async () => {
    await fc.assert(
      fc.asyncProperty(historyRepoPlan, async (plan) => {
        const repo = makeRepo(plan.commits);
        git(repo.dir, "remote", "add", "origin", "https://github.com/octo/prop.git");
        const setup: RunSetup = { repo, plan, shas: repo.shas, storedMessage: storedMessage(repo) };
        const llmCalls: { index: number; kind: string }[] = [];
        const cased = scriptHistoryCase(plan, repo.shas, llmCalls);
        const fake = createFakeGithub(
          { pulls: cased.dataset.pulls, comments: {}, issues: cased.dataset.issues },
          { pulls: cased.pullScripts },
        );
        const home = makeHome();
        return askHistory(
          repo.dir,
          plan.askFile,
          { lines: plan.lines, symbol: plan.symbol, ...CAPS },
          { github: fake.client, llm: cased.llm, hadesHome: home, now: () => FIXED_NOW },
        ).then((answer) => {
          // Property 1: every cited SHA exists as a commit.
          const checkExists = (sha: string): void => {
            git(repo.dir, "cat-file", "-e", `${sha}^{commit}`);
          };
          for (const echo of answer.echoes) checkExists(echo.sha);
          for (const commit of answer.commits) checkExists(commit.sha);
          for (const range of answer.blame) checkExists(range.sha);

          // Property 2: said quotes are verbatim substrings of their source.
          for (const echo of answer.echoes) {
            if (echo.confidence !== "said") continue;
            expect(echo.source).toBeDefined();
            expect(echo.text.length).toBeLessThanOrEqual(300);
            const { kind, ref } = echo.source!;
            let sourceText: string | undefined;
            if (kind === "commit-message") {
              sourceText = setup.storedMessage(echo.sha);
            } else if (kind === "pr-body") {
              sourceText = cased.dataset.pulls[echo.sha]?.find((p) => p.number === Number(ref))?.body;
            } else if (kind === "issue-body") {
              sourceText = cased.dataset.issues[Number(ref)]?.body;
            } else {
              expect.unreachable(`unexpected source kind ${kind}`);
            }
            expect(sourceText).toBeDefined();
            expect(sourceText!.includes(echo.text)).toBe(true);
          }

          // Property 3: inferred echoes are marked; failed scripts map exactly.
          for (const echo of answer.echoes) {
            const index = repo.shas.indexOf(echo.sha);
            const script = plan.llmScripts[index];
            if (echo.confidence === "inferred") {
              expect(echo.text).toMatch(/\bprobably\b/i);
              expect(echo.text.startsWith(`${echo.sha.slice(0, 7)}: `)).toBe(true);
              expect(echo.text.length).toBeLessThanOrEqual(300);
            }
            if (script === "no-probably" || script === "overlong") {
              expect(echo.confidence).toBe("none");
              expect(echo.text).toBe(NO_RECORD_TEXT);
            }
            if (script === "bad-quote" || script === "bad-source") {
              const pullFailed = new Set(plan.pullErrors.map((i) => repo.shas[i]));
              const pr = pullFailed.has(echo.sha)
                ? undefined
                : choosePull(cased.dataset.pulls[echo.sha] ?? []);
              const expected = ruleOrderEcho(
                echo.sha,
                expectedSources(setup, echo.sha, pr),
                expectedMeta(setup, echo.sha, pr),
              );
              expect(echo).toEqual(expected);
            }
          }
        });
      }),
      GIT_RUNS,
    );
  }, PROPERTY_TIMEOUT);

  it("warm cache equals fresh, retrying only failed and incomplete commits", async () => {
    await fc.assert(
      fc.asyncProperty(historyRepoPlan, async (plan) => {
        const repo = makeRepo(plan.commits);
        git(repo.dir, "remote", "add", "origin", "https://github.com/octo/prop.git");
        const askOpts = { lines: plan.lines, symbol: plan.symbol, ...CAPS };
        const run = (client: HistoryDeps["github"], llm: HistoryDeps["llm"], home: string) =>
          askHistory(repo.dir, plan.askFile, askOpts, {
            github: client,
            llm,
            hadesHome: home,
            now: () => FIXED_NOW,
          });

        const llmCallsA: { index: number; kind: string }[] = [];
        const casedA = scriptHistoryCase(plan, repo.shas, llmCallsA);
        const fakeA = createFakeGithub(
          { pulls: casedA.dataset.pulls, comments: {}, issues: casedA.dataset.issues },
          { pulls: casedA.pullScripts },
        );
        const homeA = makeHome();
        return run(fakeA.client, casedA.llm, homeA).then((answerA) => {
          const llmCallsB: { index: number; kind: string }[] = [];
          const casedB = scriptHistoryCase(plan, repo.shas, llmCallsB);
          const fakeB = createFakeGithub(
            { pulls: casedB.dataset.pulls, comments: {}, issues: casedB.dataset.issues },
            { pulls: casedB.pullScripts },
          );
          return run(fakeB.client, casedB.llm, homeA).then((answerB) => {
            const llmCallsC: { index: number; kind: string }[] = [];
            const casedC = scriptHistoryCase(plan, repo.shas, llmCallsC);
            const fakeC = createFakeGithub(
              { pulls: casedC.dataset.pulls, comments: {}, issues: casedC.dataset.issues },
              { pulls: casedC.pullScripts },
            );
            const homeC = makeHome();
            return run(fakeC.client, casedC.llm, homeC).then((answerC) => {
              // Property 4a: same content from cold, warm and fresh caches.
              // `github.requests` is a diagnostic counter, not content: B makes
              // fewer network calls by design, so it is normalised away.
              expect(comparable(answerB)).toEqual(comparable(answerA));
              expect(comparable(answerC)).toEqual(comparable(answerA));
              const requests = (answer: HistoryAnswer): number =>
                answer.github.mode === "github" ? answer.github.requests : 0;
              expect(requests(answerC)).toBe(requests(answerA));

              // Property 4b: B retries exactly the failed and incomplete commits.
              const llmFailed = new Set(
                plan.llmScripts
                  .map((kind, index) => ({ kind, index }))
                  .filter((s) => s.kind === "invalid" || s.kind === "throws")
                  .map((s) => s.index),
              );
              const githubIncomplete = new Set(
                plan.pullErrors.filter((index) => repo.shas[index] !== undefined),
              );
              expect(new Set(llmCallsB.map((c) => c.index))).toEqual(llmFailed);
              const githubB = new Set(
                fakeB.calls.pulls.map((c) => repo.shas.indexOf(c.sha)),
              );
              expect(githubB).toEqual(githubIncomplete);
              expect(fakeB.calls.issues).toEqual([]);
              expect(requests(answerB)).toBe(plan.pullErrors.length);
            });
          });
        });
      }),
      GIT_RUNS,
    );
  }, PROPERTY_TIMEOUT);

  it("haunted files are source files at HEAD", async () => {
    await fc.assert(
      fc.asyncProperty(fc.tuple(historyRepoPlan, fc.array(extraPatternCase, { maxLength: 2 })), async ([plan, extras]) => {
        const repo = makeRepo(plan.commits);
        const extraTest = extras.slice(0, 1).map((e) => e.pattern);
        const extraNonCode = extras.slice(1).map((e) => e.pattern);
        return rankHaunted(repo.dir, {
          top: 50,
          extraTestPatterns: extraTest,
          extraNonCodePatterns: extraNonCode,
        }, { hadesHome: makeHome() }).then((report) => {
          const isTest = makeTestFileMatcher(extraTest);
          const isNonCode = makeNonCodeMatcher(extraNonCode);
          const atHead = new Set(
            git(repo.dir, "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter((p) => p !== ""),
          );
          for (const file of report.files) {
            expect(isTest(file.path)).toBe(false);
            expect(isNonCode(file.path)).toBe(false);
            expect(atHead.has(file.path)).toBe(true);
          }
        });
      }),
      GIT_RUNS,
    );
  }, PROPERTY_TIMEOUT);
});
