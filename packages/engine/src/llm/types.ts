/** Minimal LLM seam. Injected in tests; the real client comes later (llm/client.ts). */
export interface LlmClient {
  complete(system: string, user: string): Promise<string>;
}
