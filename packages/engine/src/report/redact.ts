import type { ResolvedOptions } from "../config.js";

const MASK = "***";

/**
 * Remove the API key from a string. Repeats until the key is gone (replacing one
 * occurrence can in theory join its neighbours into another one); if that does not
 * converge, the whole string is replaced.
 */
export function redact(text: string, apiKey?: string): string {
  if (apiKey === undefined || apiKey === "") return text;
  let out = text;
  for (let i = 0; i < 10; i++) {
    if (!out.includes(apiKey)) return out;
    out = out.split(apiKey).join(MASK);
  }
  return out.includes(apiKey) ? MASK : out;
}

interface LeadingAssignment {
  prefix: string;
  name: string;
  end: number;
  unbalanced: boolean;
}

/** Parse one leading NAME=value assignment, with shell-style quotes and escapes. */
function parseLeadingAssignment(command: string): LeadingAssignment | null {
  let i = 0;
  while (i < command.length && /\s/.test(command[i]!)) i++;
  const prefix = command.slice(0, i);

  const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(command.slice(i));
  if (nameMatch === null) return null;
  i += nameMatch[0].length;
  if (command[i] !== "=") return null;
  i++;

  const contexts: Array<{ quote: '"' | "'" | null }> = [{ quote: null }];
  let unsafe = false;
  while (i < command.length) {
    const context = contexts[contexts.length - 1]!;
    const quote = context.quote;
    const char = command[i]!;
    if (char === "\\" && i + 1 === command.length && quote !== "'") {
      unsafe = true;
      break;
    }
    if (char === "\\" && i + 1 < command.length &&
        (quote === null || (quote === '"' && '$`"\\\n'.includes(command[i + 1]!)))) {
      i += 2;
      continue;
    }
    if (quote !== "'" && char === "$" && command[i + 1] === "(") {
      if (command[i + 2] === "(") { unsafe = true; break; }
      contexts.push({ quote: null });
      i += 2;
      continue;
    }
    if (quote !== "'" && (char === "`" ||
        (char === "$" && (command[i + 1] === "{" || (quote === null && command[i + 1] === "'"))) ||
        (quote === null && (char === "<" || char === ">") && command[i + 1] === "("))) {
      unsafe = true;
      break;
    }
    if (contexts.length > 1 && quote === null) {
      if (char === ")") {
        contexts.pop();
        i++;
        continue;
      }
      // These can change shell parsing (comments, grouping, redirections, or here-docs).
      if (/[\n#(;&|<>]/.test(char)) { unsafe = true; break; }
      if ((i === 0 || /[\s(]/.test(command[i - 1]!)) &&
          /^(?:case|if|for|while|until|select|function)\b/.test(command.slice(i))) {
        unsafe = true;
        break;
      }
    }
    if (quote === null && (char === '"' || char === "'")) {
      context.quote = char;
    } else if (quote === char) {
      context.quote = null;
    } else if (contexts.length === 1 && quote === null && /\s/.test(char)) {
      break;
    }
    i++;
  }

  return {
    prefix,
    name: nameMatch[0],
    end: i,
    unbalanced: unsafe || contexts.length !== 1 || contexts[0]!.quote !== null,
  };
}

/** `TOKEN=abc DEBUG=1 npm test` -> `TOKEN=*** DEBUG=*** npm test`. */
export function maskLeadingEnv(command: string): string {
  let rest = command;
  let out = "";
  for (;;) {
    const m = parseLeadingAssignment(rest);
    if (m === null) return out + rest;
    out += `${m.prefix}${m.name}=${MASK}`;
    if (m.unbalanced) return out;
    rest = rest.slice(m.end);
  }
}

function redactCommand(command: string, apiKey?: string): string {
  return redact(maskLeadingEnv(command), apiKey);
}

/** Copy of the options that is safe to put in a report. */
export function redactOptions(opts: ResolvedOptions, apiKey?: string): ResolvedOptions {
  const out: ResolvedOptions = { ...opts, testCommand: redactCommand(opts.testCommand, apiKey) };
  if (opts.installCommand !== undefined) {
    out.installCommand = redactCommand(opts.installCommand, apiKey);
  }
  return out;
}
