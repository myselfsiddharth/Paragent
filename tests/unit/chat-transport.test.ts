/**
 * `fetchFreshConnection` — the default chat transport. Tested against a real
 * local HTTP server because the property that matters is a socket-level one:
 * every request opens its own connection, so no request can be written onto an
 * idle keep-alive socket the gateway has already closed (`UND_ERR_SOCKET other
 * side closed`, 3 of 8 live fresh-baseline attempts on 2026-10-17).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChatTransportError, OpenAICompatChatClient, fetchFreshConnection } from "../../src/runner/chat-openai.js";

const FAKE_KEY = "vk-" + "TEST-" + "not-a-real-credential";

describe("fetchFreshConnection", () => {
  let server: Server;
  let base: string;
  let connections = 0;
  const seen: Array<{ method: string | undefined; auth: string | undefined; body: string }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, auth: req.headers.authorization, body });
        res.writeHead(200, { "content-type": "application/json", connection: "keep-alive" });
        res.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 1 } }));
      });
    });
    server.on("connection", () => connections++);
    // Keep-alive on the server side, so a pooled client WOULD reuse sockets.
    server.keepAliveTimeout = 60_000;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("opens a NEW connection for every request, even when the server offers keep-alive", async () => {
    const client = new OpenAICompatChatClient({ baseUrl: base, credential: FAKE_KEY, fetchImpl: fetchFreshConnection });
    const before = connections;
    for (let i = 0; i < 4; i++) {
      await client.complete({ model: "m", max_tokens: 1, temperature: 0, messages: [{ role: "user", content: `q${i}` }] });
    }
    expect(connections - before).toBe(4);
  });

  it("sends the method, bearer header and JSON body, and parses the reply", async () => {
    const client = new OpenAICompatChatClient({ baseUrl: base, credential: FAKE_KEY });
    const res = await client.complete({ model: "m", max_tokens: 1, temperature: 0, messages: [{ role: "user", content: "hello" }] });
    const last = seen[seen.length - 1]!;
    expect(last.method).toBe("POST");
    expect(last.auth).toBe(`Bearer ${FAKE_KEY}`);
    expect(JSON.parse(last.body).messages[0].content).toBe("hello");
    expect(res.usage?.prompt_tokens).toBe(7);
  });

  it("a refused connection surfaces as ChatTransportError with the socket code", async () => {
    const dead = new OpenAICompatChatClient({ baseUrl: "http://127.0.0.1:1/v1", credential: FAKE_KEY });
    const err = await dead
      .complete({ model: "m", max_tokens: 1, temperature: 0, messages: [{ role: "user", content: "x" }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatTransportError);
    expect((err as Error).message).toContain("ECONNREFUSED");
    expect((err as Error).message).not.toContain(FAKE_KEY);
  });
});
