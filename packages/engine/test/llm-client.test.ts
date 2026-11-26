import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenAiCompatibleClient, LlmHttpError, LlmNetworkError } from "../src/llm/client.js";

const KEY = "sk-test-key-123456";
let server: http.Server | undefined;
let lastRequest: { url?: string; auth?: string; body?: any } = {};

async function start(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      lastRequest = {
        url: req.url,
        auth: req.headers.authorization,
        body: data ? JSON.parse(data) : undefined,
      };
      handler(req, res);
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server!.close(r));
    server = undefined;
  }
});

const cfg = (baseUrl: string) => ({ baseUrl, apiKey: KEY, model: "m1" });

describe("createOpenAiCompatibleClient", () => {
  it("posts to /chat/completions and returns the message content", async () => {
    const base = await start((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "hello" } }] }));
    });
    const client = createOpenAiCompatibleClient(cfg(`${base}/v1/`));
    expect(await client.complete("sys", "usr")).toBe("hello");
    expect(lastRequest.url).toBe("/v1/chat/completions");
    expect(lastRequest.auth).toBe(`Bearer ${KEY}`);
    expect(lastRequest.body).toMatchObject({
      model: "m1",
      temperature: 0,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
      ],
    });
    expect(lastRequest.body).not.toHaveProperty("response_format");
  });

  it("returns the raw body when it is not a chat completion", async () => {
    const base = await start((_req, res) => res.end("not json"));
    expect(await createOpenAiCompatibleClient(cfg(base)).complete("s", "u")).toBe("not json");
  });

  it("throws LlmHttpError with the status, with the key redacted and body trimmed", async () => {
    const base = await start((_req, res) => {
      res.statusCode = 500;
      res.end(`bad key ${KEY} ${"x".repeat(2000)}`);
    });
    const err = await createOpenAiCompatibleClient(cfg(base))
      .complete("s", "u")
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(err.status).toBe(500);
    expect(err.message).not.toContain(KEY);
    expect(err.message.length).toBeLessThan(600);
  });

  it("throws LlmNetworkError when the connection fails", async () => {
    const base = await start((_req, res) => res.end("{}"));
    await new Promise((r) => server!.close(r));
    server = undefined;
    const err = await createOpenAiCompatibleClient(cfg(base))
      .complete("s", "u")
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmNetworkError);
    expect(err.message).not.toContain(KEY);
  });

  it("throws LlmNetworkError on timeout", async () => {
    const base = await start(() => {
      /* never answer */
    });
    const err = await createOpenAiCompatibleClient(cfg(base), { timeoutMs: 100 })
      .complete("s", "u")
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmNetworkError);
    expect(err.message).toMatch(/timed out/);
  });

  it("redacts the key when it appears in the base URL of a failed request", async () => {
    const err = await createOpenAiCompatibleClient({
      baseUrl: `http://127.0.0.1:1/${KEY}`,
      apiKey: KEY,
      model: "m",
    })
      .complete("s", "u")
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmNetworkError);
    expect(JSON.stringify(err.message)).not.toContain(KEY);
  });
});
