import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { startServer } from "../../src/server";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { loadConfig, saveConfig } from "../../src/config";
import { addFinalRequestLog, nextRequestLogId, type RequestLogContext } from "../../src/server/request-log";
import { clearProviderCacheAffinityForTests } from "../../src/providers/cache-affinity";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const REAL_FETCH = globalThis.fetch;
let testDir = "";
let previousHome: string | undefined;
const seenAuth: string[] = [];
const failingKeys = new Set<string>();
// Direct handler calls need the spend-ledger ownership startServer acquires.
const trackedServers = new Set<ReturnType<typeof startServer>>();

function makeConfig(): OcxConfig {
  const config = {
    port: 0,
    providers: {
      "affinity-e2e": {
        adapter: "openai-chat",
        authMode: "key",
        baseUrl: "https://upstream.invalid/v1",
        apiKey: "key-a",
        models: ["test"],
        liveModels: false,
        apiKeyPool: [
          { id: "a", key: "key-a" },
          { id: "b", key: "key-b" },
        ],
      },
      "affinity-chat": {
        adapter: "openai-chat",
        authMode: "key",
        baseUrl: "https://upstream.invalid/v1",
        apiKey: "key-a",
        models: ["test"],
        liveModels: false,
        apiKeyPool: [
          { id: "a", key: "key-a" },
          { id: "b", key: "key-b" },
        ],
      },
      "affinity-compact": {
        adapter: "openai-responses",
        authMode: "key",
        baseUrl: "https://upstream.invalid/v1",
        apiKey: "key-a",
        models: ["test"],
        liveModels: false,
        apiKeyPool: [
          { id: "a", key: "key-a" },
          { id: "b", key: "key-b" },
        ],
      },
      "affinity-msg": {
        adapter: "anthropic",
        authMode: "key",
        baseUrl: "https://upstream.invalid",
        apiKey: "key-a",
        models: ["claude-test"],
        liveModels: false,
        apiKeyPool: [
          { id: "a", key: "key-a" },
          { id: "b", key: "key-b" },
        ],
      },
    },
  } as unknown as OcxConfig;
  saveConfig(config);
  return loadConfig();
}

async function turn(config: OcxConfig, threadId: string): Promise<RequestLogContext> {
  saveConfig(config);
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "thread-id": threadId },
    body: JSON.stringify({ model: "affinity-e2e/test", input: "hello", stream: false, store: false }),
  }), config, logCtx, {});
  expect(response.status).toBe(200);
  await response.text();
  // The ingress layer owns finalization in production; this harness stands in for it.
  addFinalRequestLog(nextRequestLogId(), Date.now(), logCtx, response.status);
  return logCtx;
}

describe("provider cache affinity (end-to-end)", () => {
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-cache-affinity-e2e-"));
    process.env.OPENCODEX_HOME = testDir;
    saveConfig(makeConfig());
    trackedServers.add(startServer(0));
    clearKeyCooldowns();
    clearProviderCacheAffinityForTests();
    seenAuth.length = 0;
    failingKeys.clear();
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const auth = headers.get("authorization") ?? (headers.get("x-api-key") ? `Bearer ${headers.get("x-api-key")}` : "");
      seenAuth.push(auth);
      const key = auth.replace("Bearer ", "");
      if (failingKeys.has(key)) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429, headers: { "content-type": "application/json" },
        });
      }
      if (_url.toString().includes("/responses")) {
        return new Response(JSON.stringify({
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "fixture reply" }] }],
          usage: { input_tokens: 5000, output_tokens: 10, input_tokens_details: { cached_tokens: 4000 } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (_url.toString().includes("/messages")) {
        // The native Messages path consumes an Anthropic SSE stream.
        const sse = [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-test","type":"message","role":"assistant","model":"claude-test","content":[],"stop_reason":null,"usage":{"input_tokens":5000,"output_tokens":1,"cache_read_input_tokens":4000,"cache_creation_input_tokens":0}}}',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
          'event: message_stop\ndata: {"type":"message_stop"}',
        ].join("\n\n") + "\n\n";
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1,
        model: "test",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 5000,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 4000, cache_write_tokens: 4000 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  });

  afterEach(async () => {
    for (const server of trackedServers) {
      trackedServers.delete(server);
      await server.stop(true);
    }
    globalThis.fetch = REAL_FETCH;
    clearKeyCooldowns();
    clearProviderCacheAffinityForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (testDir) removeTreeWithRetry(testDir);
  });

  test("a conversation stays on the credential that warmed its cache after the committed key moves", async () => {
    const config = makeConfig();
    const first = await turn(config, "conv-1");
    expect(seenAuth).toEqual(["Bearer key-a"]);
    expect(first.cacheAffinity).toBe("bound");

    // Another conversation (or an operator) moved the provider's committed key.
    config.providers["affinity-e2e"]!.apiKey = "key-b";
    saveConfig(config);

    const second = await turn(config, "conv-1");
    expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-a"]);
    expect(second.cacheAffinity).toBe("kept");
    expect(second.cacheAffinityReason).toBe("cache");

    // A different conversation is placed by ordinary selection: the moved key.
    await turn(config, "conv-2");
    expect(seenAuth.at(-1)).toBe("Bearer key-b");
  });

  test("a 429 on the bound key rotates, and the conversation rebinds to the spare", async () => {
    const config = makeConfig();
    await turn(config, "conv-1");
    expect(seenAuth).toEqual(["Bearer key-a"]);

    failingKeys.add("key-a");
    const rotated = await turn(config, "conv-1");
    expect(seenAuth.at(-1)).toBe("Bearer key-b");
    expect(rotated.cacheAffinity).toBe("bound");

    failingKeys.clear();
    const third = await turn(config, "conv-1");
    expect(seenAuth.at(-1)).toBe("Bearer key-b");
    expect(third.cacheAffinity).toBe("kept");
  });

  test("when every key fails, the binding is released and the next turn starts fresh", async () => {
    const config = makeConfig();
    await turn(config, "conv-1");
    failingKeys.add("key-a");
    failingKeys.add("key-b");
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "thread-id": "conv-1" },
      body: JSON.stringify({ model: "affinity-e2e/test", input: "hello", stream: false, store: false }),
    }), config, logCtx, {});
    await response.text();
    addFinalRequestLog(nextRequestLogId(), Date.now(), logCtx, response.status);
    expect(response.status).toBe(429);
    expect(logCtx.cacheAffinity).toBe("released");

    failingKeys.clear();
    seenAuth.length = 0;
    const fresh = await turn(config, "conv-1");
    // The failed turn's rotation committed key-b, so fresh placement starts
    // there; the released binding does not drag the conversation back to a.
    expect(seenAuth[0]).toBe("Bearer key-b");
    expect(fresh.cacheAffinity).toBe("bound");
  });

  test("cacheAffinity off restores plain committed-key behavior", async () => {
    const config = makeConfig();
    config.providers["affinity-e2e"]!.cacheAffinity = "off";
    await turn(config, "conv-1");
    config.providers["affinity-e2e"]!.apiKey = "key-b";
    await turn(config, "conv-1");
    expect(seenAuth).toEqual(["Bearer key-a", "Bearer key-b"]);
  });

describe("lane wiring on the chat and messages paths", () => {
  test("chat completions: the second turn of a conversation stays on its key", async () => {
    const config = makeConfig();
    const turn = async (): Promise<RequestLogContext> => {
      const logCtx: RequestLogContext = { model: "", provider: "" };
      const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "thread-id": "chat-conv-1" },
        body: JSON.stringify({ model: "affinity-chat/test", messages: [{ role: "user", content: "hi" }] }),
      }), config, logCtx, { requestId: nextRequestLogId(), start: Date.now() });
      expect(response.status).toBe(200);
      await response.text();
      return logCtx;
    };
    const first = await turn();
    expect(seenAuth).toEqual(["Bearer key-a"]);
    expect(first.cacheAffinity).toBe("bound");
    config.providers["affinity-chat"]!.apiKey = "key-b";
    saveConfig(config);
    const second = await turn();
    expect(seenAuth.at(-1)).toBe("Bearer key-a");
    expect(second.cacheAffinity).toBe("kept");
  });

  test("responses compact: the second turn of a conversation stays on its key", async () => {
    const config = makeConfig();
    const turn = async (): Promise<RequestLogContext> => {
      saveConfig(config);
      const logCtx: RequestLogContext = { model: "", provider: "" };
      const response = await handleResponsesCompact(new Request("http://localhost/v1/responses/compact", {
        method: "POST",
        headers: { "content-type": "application/json", "thread-id": "compact-conv-1" },
        body: JSON.stringify({
          model: "affinity-compact/test",
          input: [{ role: "user", content: "fixture question" }],
          stream: false,
        }),
      }), config, logCtx);
      expect(response.status).toBe(200);
      await response.text();
      addFinalRequestLog(nextRequestLogId(), Date.now(), logCtx, response.status);
      return logCtx;
    };
    const first = await turn();
    expect(seenAuth).toEqual(["Bearer key-a"]);
    expect(first.cacheAffinity).toBe("bound");
    config.providers["affinity-compact"]!.apiKey = "key-b";
    saveConfig(config);
    const second = await turn();
    expect(seenAuth.at(-1)).toBe("Bearer key-a");
    expect(second.cacheAffinity).toBe("kept");
  });

  test("claude messages: the second turn of a conversation stays on its key", async () => {
    const config = makeConfig();
    const turn = async (): Promise<RequestLogContext> => {
      const logCtx: RequestLogContext = { model: "", provider: "" };
      const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "session_id": "msg-conv-1" },
        body: JSON.stringify({
          model: "affinity-msg/claude-test", max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      }), config, logCtx, { requestId: nextRequestLogId(), start: Date.now() });
      expect(response.status).toBe(200);
      await response.text();
      return logCtx;
    };
    const first = await turn();
    expect(seenAuth).toEqual(["Bearer key-a"]);
    expect(first.cacheAffinity).toBe("bound");
    config.providers["affinity-msg"]!.apiKey = "key-b";
    saveConfig(config);
    const second = await turn();
    expect(seenAuth.at(-1)).toBe("Bearer key-a");
    expect(second.cacheAffinity).toBe("kept");
  });
});
});
