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


test("speech health reports Workers AI availability", async () => {
  const env = {
    ...baseEnv,
    AI: { run: async () => ({}) },
  };
  const response = await worker.fetch(
    new Request("https://router.example/v1/speech/health", {
      headers: { Authorization: "Bearer test-access-token" },
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).available, true);
});

test("speech transcription sends uploaded audio to Cloudflare Whisper", async () => {
  let receivedModel = "";
  let receivedInput;
  const env = {
    ...baseEnv,
    AI: {
      run: async (model, input) => {
        receivedModel = model;
        receivedInput = input;
        return { text: "Hello JARVIS", language: "en", duration: 2.5 };
      },
    },
  };
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), "recording.webm");
  const response = await worker.fetch(
    new Request("https://router.example/v1/speech/transcribe", {
      method: "POST",
      headers: { Authorization: "Bearer test-access-token" },
      body: form,
    }),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(receivedModel, "@cf/openai/whisper-large-v3-turbo");
  assert.equal(receivedInput.audio, "AQID");
  const result = await response.json();
  assert.equal(result.text, "Hello JARVIS");
  assert.equal(result.language, "en");
  assert.equal(result.duration_seconds, 2.5);
});

test("speech synthesis returns MP3 audio from Cloudflare Aura", async () => {
  let receivedModel = "";
  let receivedInput;
  const env = {
    ...baseEnv,
    AI: {
      run: async (model, input, options) => {
        receivedModel = model;
        receivedInput = input;
        assert.equal(options.returnRawResponse, true);
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        });
      },
    },
  };
  const response = await worker.fetch(
    new Request("https://router.example/v1/speech/synthesize", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-access-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "Hello there", voice_id: "bm_george" }),
    }),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(receivedModel, "@cf/deepgram/aura-1");
  assert.equal(receivedInput.text, "Hello there");
  assert.equal(receivedInput.speaker, "angus");
  assert.equal(response.headers.get("Content-Type"), "audio/mpeg");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
});


test("registers additional hosted provider adapters when credentials exist", () => {
  const providers = [
    ["gemini", "GEMINI_API_KEY"],
    ["xai", "XAI_API_KEY"],
    ["huggingface", "HF_TOKEN"],
    ["fireworks", "FIREWORKS_API_KEY"],
    ["nvidia", "NVIDIA_API_KEY"],
    ["sambanova", "SAMBANOVA_API_KEY"],
  ];
  const env = {
    ...baseEnv,
    ...Object.fromEntries(providers.map(([, key]) => [key, "configured"])),
    JARVIS_MODELS: JSON.stringify(providers.map(([provider]) => ({
      id: `${provider}/test-model`,
      provider,
      apiModel: "test-model",
      billing: "metered",
      priority: 50,
      capabilities: ["chat"],
    }))),
  };
  const models = getConfiguredModels(env);
  for (const [provider] of providers) {
    assert.ok(models.some((model) => model.provider === provider), `${provider} should be registered`);
  }
});

test("billing and missing-model errors are eligible for fallback", async () => {
  const originalFetch = globalThis.fetch;
  const attempted = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    attempted.push(url);
    return new Response(JSON.stringify({ error: "model unavailable" }), {
      status: url.includes("ollama.com") ? 402 : 200,
      headers: { "Content-Type": url.includes("ollama.com") ? "application/json" : "text/event-stream" },
    });
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
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
        }),
      }),
      baseEnv,
    );
    assert.equal(response.status, 200);
    assert.equal(attempted.length, 2);
    assert.equal(response.headers.get("X-Jarvis-Provider"), "openrouter");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
