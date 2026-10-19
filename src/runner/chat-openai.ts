/**
 * A minimal OpenAI-spec chat transport, shared by the Voyager repair and
 * fresh-baseline clients.
 *
 * ## Why this exists instead of the `openai` package
 *
 * ASU's Voyager gateway (`openai.rc.asu.edu/v1`, a vLLM fleet behind an
 * OpenAI-spec proxy) needs exactly one endpoint — `POST /chat/completions` —
 * and the repo's rule is no dependency without an ADR. `node:https` is
 * enough, and a hand-rolled transport is a hundred lines whose every failure
 * path is visible here rather than inside a vendored retry loop. (Not `fetch`:
 * its pooled keep-alive sockets race the gateway's idle timeout — see
 * `fetchFreshConnection`.)
 *
 * ## No retries, no fallbacks
 *
 * Same posture as `repair-anthropic.ts`: a hidden retry hides cost, and a
 * silent fallback would let a different model serve a call while `model_id`
 * still names the requested one. A failed request throws `ChatHttpError`; the
 * client above it decides how to report it.
 *
 * ## Token accounting differs from the Anthropic clients — on purpose
 *
 * Anthropic reports `input_tokens`, `cache_read_input_tokens` and
 * `cache_creation_input_tokens` as three separate, additive line items, so
 * `billedInputTokens()` sums them. OpenAI-spec `prompt_tokens` is the opposite:
 * it is the **total** prompt size, and `prompt_tokens_details.cached_tokens`
 * is a subset of it. Summing them here would double-count every cached token
 * and inflate `cost_repair` against the §9 kill line. `billedPromptTokens()`
 * therefore returns `prompt_tokens` alone.
 *
 * Server-side prefix caching on a vLLM fleet is automatic and cannot be turned
 * off by the caller, unlike the Anthropic clients' "caching is off" posture.
 * Cached tokens are still real prompt tokens, so they stay in `tokens_in`; the
 * cached subset is surfaced separately (`cachedPromptTokens()`) and written
 * into the run notes so a reader can see how much of the figure was cache.
 * `completion_tokens` includes any reasoning tokens a thinking model spent.
 */

import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

export const DEFAULT_VOYAGER_BASE_URL = "https://openai.rc.asu.edu/v1";

/** Generous: a 235B-parameter model behind a shared queue is not fast. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  temperature: number;
  response_format?: {
    type: "json_schema";
    json_schema: { name: string; strict: boolean; schema: unknown };
  };
}

export interface ChatUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
}

export interface ChatResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null } | null;
  }>;
  usage?: ChatUsage | null;
}

/** The seam tests inject. The real implementation never runs in `npm run ci`. */
export interface ChatClient {
  complete(request: ChatRequest): Promise<ChatResponse>;
}

/**
 * No HTTP response at all — the connection failed, was reset, or timed out.
 *
 * Distinct from `ChatHttpError` because the two mean different things for a
 * measurement: an HTTP error is the gateway answering, a transport error is the
 * network not delivering. Node reports the latter as a bare `fetch failed` with
 * the real reason in `cause`; it is surfaced here so a ledger can say *why*.
 * (2 of the first 7 live fresh-baseline attempts on Voyager ended this way.)
 */
export class ChatTransportError extends Error {
  readonly transport = true as const;
  constructor(detail: string, options?: { cause?: unknown }) {
    super(`chat transport failed: ${detail}`, options);
    this.name = "ChatTransportError";
  }
}

function describeTransportFailure(err: unknown): string {
  const e = err as {
    name?: string;
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string; name?: string };
  };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return `timeout (${e.name})`;
  const cause = e?.cause;
  const why = cause ? [cause.code, cause.name, cause.message].filter(Boolean).join(" ") : "";
  const own = e?.code ? `${e.code} ` : "";
  return `${own}${e?.message ?? String(err)}${why ? ` — ${why}` : ""}`.slice(0, 200);
}

/**
 * The default transport: one TCP/TLS connection per request, never reused.
 *
 * Node's `fetch` pools keep-alive sockets. The Voyager gateway's proxy closes
 * idle ones, and a fresh-baseline turn leaves the socket idle for exactly as
 * long as the browser takes to act — so `fetch` would sometimes write a request
 * onto a socket the proxy had just closed: `UND_ERR_SOCKET other side closed`,
 * on 3 of 8 live attempts (2026-10-17), each one a truncated measurement. With
 * `agent: false` there is no idle socket to lose. The cost is one handshake per
 * call, against model calls that take seconds.
 *
 * Fetch-shaped so it slots behind the same `fetchImpl` seam the tests inject.
 */
export const fetchFreshConnection: typeof fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, reject) => {
    const req = send(
      url,
      {
        method: init?.method ?? "GET",
        headers: init?.headers as Record<string, string> | undefined,
        agent: false,
        ...(init?.signal ? { signal: init.signal } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const nullBody = status === 204 || status === 205 || status === 304;
          resolve(
            new Response(nullBody ? null : Buffer.concat(chunks), {
              status,
              headers: toHeaders(res.headers),
            }),
          );
        });
      },
    );
    req.on("error", reject);
    if (typeof init?.body === "string") req.write(init.body);
    req.end();
  });
};

function toHeaders(raw: IncomingHttpHeaders): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
  }
  return h;
}

/** HTTP-level failure. Carries the status, never the credential. */
export class ChatHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`chat request failed with HTTP ${status}: ${detail}`);
    this.name = "ChatHttpError";
  }
}

export interface OpenAICompatOptions {
  baseUrl: string;
  /** Named `credential`, not the obvious thing — see the note in repair-anthropic.ts (secret-scan). */
  credential: string;
  timeoutMs?: number;
  /** Injected in tests of the transport itself. */
  fetchImpl?: typeof fetch;
}

export class OpenAICompatChatClient implements ChatClient {
  private readonly url: string;
  private readonly credential: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatOptions) {
    this.url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.credential = options.credential;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetchFreshConnection;
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    let res: Response;
    let body: string;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.credential}`,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      body = await res.text();
    } catch (err) {
      throw new ChatTransportError(
        describeTransportFailure(err).split(this.credential).join("<redacted>"),
        { cause: err },
      );
    }
    if (!res.ok) {
      // First line only, length-capped, and scrubbed of the credential in case
      // a proxy echoes request headers back in an error page.
      const detail = body.split("\n")[0]!.slice(0, 200).split(this.credential).join("<redacted>");
      throw new ChatHttpError(res.status, detail);
    }
    return JSON.parse(body) as ChatResponse;
  }
}

/** Total prompt tokens. `cached_tokens` is a subset of this — never added. */
export function billedPromptTokens(usage: ChatUsage | null | undefined): number {
  return usage?.prompt_tokens ?? 0;
}

export function billedCompletionTokens(usage: ChatUsage | null | undefined): number {
  return usage?.completion_tokens ?? 0;
}

/** The cached subset of `billedPromptTokens()`. For notes only. */
export function cachedPromptTokens(usage: ChatUsage | null | undefined): number {
  return usage?.prompt_tokens_details?.cached_tokens ?? 0;
}

/**
 * Parse the model's JSON reply.
 *
 * `response_format: json_schema` is honoured by this gateway, so the happy path
 * is a bare `JSON.parse`. The fence stripping is for the day a model on the
 * fleet ignores the constraint and wraps its answer in a markdown block — a
 * paid call that parses is better than a paid call that is discarded.
 */
export function parseJsonReply(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fenced ? fenced[1]! : trimmed);
}
