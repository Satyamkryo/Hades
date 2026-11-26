import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { resolveOptions } from "../src/config.js";
import { maskLeadingEnv, redact, redactOptions } from "../src/report/redact.js";

describe("redact", () => {
  it("removes every occurrence of the key", () => {
    expect(redact("a sk-123 b sk-123", "sk-123")).toBe("a *** b ***");
  });
  it("leaves text alone without a key", () => {
    expect(redact("hello")).toBe("hello");
    expect(redact("hello", "")).toBe("hello");
  });
});

describe("maskLeadingEnv", () => {
  it("masks leading assignments only", () => {
    expect(maskLeadingEnv("TOKEN=abc DEBUG=1 npm test")).toBe("TOKEN=*** DEBUG=*** npm test");
    expect(maskLeadingEnv("npm test FOO=bar")).toBe("npm test FOO=bar");
  });
  it("handles quoted values with spaces and unbalanced quotes", () => {
    expect(maskLeadingEnv('A="x y" npm test')).toBe("A=*** npm test");
    expect(maskLeadingEnv('A="x y npm test')).toBe("A=***");
  });
  it("handles escaped quotes inside double-quoted values", () => {
    expect(maskLeadingEnv('A="x \\"y\\" z" npm test')).toBe("A=*** npm test");
  });
  it("treats backslashes literally inside single quotes and masks following assignments", () => {
    expect(maskLeadingEnv("A='x\\' B=secret npm test")).toBe("A=*** B=*** npm test");
  });
  it("handles escaped whitespace outside quotes", () => {
    expect(maskLeadingEnv("A=x\\ y B=secret npm test")).toBe("A=*** B=*** npm test");
  });
  it("masks complete command substitutions, including nested and quoted substitutions", () => {
    expect(maskLeadingEnv('TOKEN=$(printf "%s %s" secret value) NEXT=abc npm test'))
      .toBe("TOKEN=*** NEXT=*** npm test");
    expect(maskLeadingEnv('TOKEN="$(printf %s "$(echo secret value)")" npm test'))
      .toBe("TOKEN=*** npm test");
  });
  it("masks the remainder when substitution syntax is incomplete or unsafe to parse", () => {
    for (const command of [
      "TOKEN=$(printf secret value npm test",
      "TOKEN=$(case x in x) secret ;; esac) npm test",
      "TOKEN=$(echo ok # ) secret\n) npm test",
      "TOKEN=`echo secret value` npm test",
      "TOKEN=${value:-secret value} npm test",
      "TOKEN=<(echo secret value) npm test",
    ]) expect(maskLeadingEnv(command)).toBe("TOKEN=***");
  });
  it("continues masking after an empty assignment", () => {
    expect(maskLeadingEnv("A= B=secret npm test")).toBe("A=*** B=*** npm test");
  });
});

describe("redactOptions", () => {
  it("masks env and key in testCommand and installCommand, keeps the rest", () => {
    const opts = resolveOptions({
      testCommand: "TOKEN=abc npm test -- --key sk-secret-1",
      installCommand: "NPM_TOKEN=zzz npm ci",
    });
    const out = redactOptions(opts, "sk-secret-1");
    expect(out.testCommand).toBe("TOKEN=*** npm test -- --key ***");
    expect(out.installCommand).toBe("NPM_TOKEN=*** npm ci");
    expect(out.timeoutMs).toBe(opts.timeoutMs);
    expect(opts.testCommand).toContain("abc");
  });
});

describe("redaction properties", () => {
  const key = fc.stringMatching(/^[A-Za-z0-9_-]{8,24}$/);
  const name = fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,8}$/);
  const secret = fc.stringMatching(/^[a-f0-9]{8,16}$/).map((s) => `S3CR3T${s}`);

  it("output never contains the key or an unmasked leading assignment", () => {
    fc.assert(
      fc.property(
        key,
        fc.array(fc.tuple(name, secret), { maxLength: 4 }),
        fc.constantFrom("npm test", "pnpm run test:unit", "node check.mjs"),
        fc.boolean(),
        (apiKey, assignments, base, keyInArgs) => {
          const prefix = assignments.map(([n, v]) => `${n}=${v} `).join("");
          const command = `${prefix}${base}${keyInArgs ? ` --token ${apiKey}` : ""}`;
          const out = redactOptions(resolveOptions({ testCommand: command }), apiKey).testCommand;
          expect(out).not.toContain(apiKey);
          expect(out).not.toContain("S3CR3T");
          for (const [n] of assignments) expect(out).toContain(`${n}=***`);
        },
      ),
      { numRuns: 100 },
    );
  });
});
