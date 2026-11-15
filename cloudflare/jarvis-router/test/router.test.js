import test from "node:test";
import assert from "node:assert/strict";
import worker, { getConfiguredModels, resolveCandidates } from "../src/index.js";

const baseEnv = {
  JARVIS_ACCESS_TOKEN: "test-access-token",
  OLLAMA_API_KEY: "ollama-secret",
  OPENROUTER_API_KEY: "openrouter-secret",
  OLLAMA_CLOUD_MODEL_MAP: JSON.stringify({
    "gemma4:cloud": "gemma4:31b",
  }),
  JARVIS_MODELS: JSON.stringify([
    {
      id: "openrouter/vendor/fallback-model",
      provider: "openrouter",
      apiModel: "vendor/fallback-model",
      label: "Fallback model",
      billing: "free",
      priority: 20,
      capabilities: ["chat"],
    },
  ]),
  JARVIS_FALLBACK_ORDER: JSON.stringify([
    "ollama-cloud/gemma4:cloud",
    "openrouter/vendor/fallback-model",
  ]),
};

test("maps Ollama :cloud selector to the configured hosted API model ID", () => {
  const models = getConfiguredModels(baseEnv);
  const ollama = models.find((model) => model.id === "ollama-cloud/gemma4:cloud");
  assert.ok(ollama);
  assert.equal(ollama.apiModel, "gemma4:31b");
  assert.equal(ollama.billing, "metered");
});

test("does not expose Ollama cloud models when the provider key is absent", () => {
  const env = { ...baseEnv, OLLAMA_API_KEY: "" };
  const models = getConfiguredModels(env);
  assert.equal(models.some((model) => model.provider === "ollama-cloud"), false);
});

test("free-first routing excludes metered Ollama Cloud models", () => {
  const models = getConfiguredModels(baseEnv);
  const candidates = resolveCandidates("jarvis/free-first", baseEnv, models);
  assert.deepEqual(candidates.map((model) => model.id), [
    "openrouter/vendor/fallback-model",
  ]);
});

test("protected model endpoint rejects requests without the JARVIS token", async () => {
  const response = await worker.fetch(
    new Request("https://router.example/v1/models"),
    baseEnv,
  );
  assert.equal(response.status, 401);
});

test("model endpoint returns the cloud selector and auto profile", async () => {
  const response = await worker.fetch(
    new Request("https://router.example/v1/models", {
      headers: { Authorization: "Bearer test-access-token" },
    }),
    baseEnv,
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.data.some((model) => model.id === "ollama-cloud/gemma4:cloud"));
  assert.ok(result.data.some((model) => model.id === "jarvis/auto"));
});

test("chat request falls back before streaming when the first provider fails", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("ollama.com")) {
      return new Response(JSON.stringify({ error: "temporary upstream failure" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("openrouter.ai")) {
      return new Response(
        'data: {"id":"chatcmpl-test","choices":[{"delta":{"content":"Hello from backup"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }
    throw new Error("Unexpected upstream URL");
  };

  try {
    const response = await worker.fetch(
      new Request("https://router.example/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-access-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "ollama-cloud/gemma4:cloud",
          messages: [{ role: "user", content: "Say hello" }],
          stream: true,
        }),
      }),
      baseEnv,
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Jarvis-Provider"), "openrouter");
    assert.equal(response.headers.get("X-Jarvis-Fallback-Count"), "1");
    assert.equal(calls.length, 2);
    assert.match(await response.text(), /Hello from backup/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
