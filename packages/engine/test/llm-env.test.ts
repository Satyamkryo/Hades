import { describe, expect, it } from "vitest";
import { HadesConfigError } from "../src/errors.js";
import { readLlmEnv } from "../src/llm/env.js";

describe("readLlmEnv", () => {
  it("returns the three settings", () => {
    expect(
      readLlmEnv({
        HADES_LLM_BASE_URL: "http://x/v1",
        HADES_LLM_API_KEY: "k",
        HADES_LLM_MODEL: "m",
      }),
    ).toEqual({ baseUrl: "http://x/v1", apiKey: "k", model: "m" });
  });

  it("names every missing variable, treating blank as missing", () => {
    const run = () => readLlmEnv({ HADES_LLM_API_KEY: "   ", HADES_LLM_MODEL: "m" });
    expect(run).toThrow(HadesConfigError);
    expect(run).toThrow(/HADES_LLM_BASE_URL, HADES_LLM_API_KEY/);
    expect(run).not.toThrow(/HADES_LLM_MODEL/);
  });

  it("names all three when none is set", () => {
    expect(() => readLlmEnv({})).toThrow(
      /HADES_LLM_BASE_URL, HADES_LLM_API_KEY, HADES_LLM_MODEL/,
    );
  });
});
