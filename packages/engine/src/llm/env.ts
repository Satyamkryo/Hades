import { HadesConfigError } from "../errors.js";

export interface LlmEnv {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const VARS = {
  baseUrl: "HADES_LLM_BASE_URL",
  apiKey: "HADES_LLM_API_KEY",
  model: "HADES_LLM_MODEL",
} as const;

/**
 * Read the LLM connection settings from the environment.
 * A variable that is unset, empty or whitespace-only counts as missing. The error names
 * every missing variable and never includes any value.
 */
export function readLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnv {
  const missing: string[] = [];
  const read = (name: string): string => {
    const value = env[name]?.trim() ?? "";
    if (value === "") missing.push(name);
    return value;
  };

  const baseUrl = read(VARS.baseUrl);
  const apiKey = read(VARS.apiKey);
  const model = read(VARS.model);

  if (missing.length > 0) {
    throw new HadesConfigError(`Missing LLM environment variable(s): ${missing.join(", ")}`);
  }
  return { baseUrl, apiKey, model };
}
