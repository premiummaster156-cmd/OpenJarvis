const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const PROVIDERS = {
  "ollama-cloud": {
    baseUrl: "https://ollama.com/v1",
    keyName: "OLLAMA_API_KEY",
  },
  "openai": {
    baseUrl: "https://api.openai.com/v1",
    keyName: "OPENAI_API_KEY",
  },
  "openrouter": {
    baseUrl: "https://openrouter.ai/api/v1",
    keyName: "OPENROUTER_API_KEY",
  },
  "groq": {
    baseUrl: "https://api.groq.com/openai/v1",
    keyName: "GROQ_API_KEY",
  },
  "cerebras": {
    baseUrl: "https://api.cerebras.ai/v1",
    keyName: "CEREBRAS_API_KEY",
  },
  "mistral": {
    baseUrl: "https://api.mistral.ai/v1",
    keyName: "MISTRAL_API_KEY",
  },
  "together": {
    baseUrl: "https://api.together.xyz/v1",
    keyName: "TOGETHER_API_KEY",
  },
  "deepseek": {
    baseUrl: "https://api.deepseek.com/v1",
    keyName: "DEEPSEEK_API_KEY",
  },
  "gemini": {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyName: "GEMINI_API_KEY",
  },
  "xai": {
    baseUrl: "https://api.x.ai/v1",
    keyName: "XAI_API_KEY",
  },
  "huggingface": {
    baseUrl: "https://router.huggingface.co/v1",
    keyName: "HF_TOKEN",
  },
  "fireworks": {
    baseUrl: "https://api.fireworks.ai/inference/v1",
    keyName: "FIREWORKS_API_KEY",
  },
  "nvidia": {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyName: "NVIDIA_API_KEY",
  },
  "sambanova": {
    baseUrl: "https://api.sambanova.ai/v1",
    keyName: "SAMBANOVA_API_KEY",
  },
  "workers-ai": {
    keyName: "CLOUDFLARE_AI_TOKEN",
    cloudflare: true,
  },
};

const MAX_BODY_BYTES = 1_500_000;
const MAX_MESSAGES = 100;
const MAX_ATTEMPTS_LIMIT = 6;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function parseJson(value, fallback) {
  if (!value || typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getAllowedOrigins(env) {
  const configured = String(env.JARVIS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.length ? configured : ["*"];
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = getAllowedOrigins(env);
  const allowOrigin = allowed.includes("*")
    ? "*"
    : allowed.includes(origin)
      ? origin
      : "null";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

async function isAuthorized(request, env) {
  if (!env.JARVIS_ACCESS_TOKEN) return false;
  const match = /^Bearer\s+(.+)$/i.exec(
    request.headers.get("Authorization") || "",
  );
  return match ? tokenMatches(match[1], env.JARVIS_ACCESS_TOKEN) : false;
}

function providerReady(provider, env) {
  const config = PROVIDERS[provider];
  if (!config) return false;
  if (config.cloudflare) {
    return Boolean(env.CLOUDFLARE_ACCOUNT_ID && env[config.keyName]);
  }
  return Boolean(env[config.keyName]);
}

function normaliseModel(model, provider) {
  if (!model || typeof model !== "object") return null;
  const id = String(model.id || "").trim();
  const apiModel = String(model.apiModel || "").trim();
  if (!id || !apiModel || !PROVIDERS[provider || model.provider]) return null;
  const selectedProvider = provider || model.provider;
  return {
    id,
    apiModel,
    provider: selectedProvider,
    label: String(model.label || id),
    billing: ["free", "metered", "paid"].includes(model.billing)
      ? model.billing
      : "unknown",
    priority: Number.isFinite(Number(model.priority))
      ? Number(model.priority)
      : 100,
    capabilities: Array.isArray(model.capabilities)
      ? model.capabilities.filter((item) => typeof item === "string").slice(0, 16)
      : ["chat"],
  };
}

export function getConfiguredModels(env) {
  const models = [];
  const seen = new Set();

  const add = (model) => {
    if (!model || seen.has(model.id) || !providerReady(model.provider, env)) return;
    seen.add(model.id);
    models.push(model);
  };

  const configured = parseJson(env.JARVIS_MODELS, []);
  if (Array.isArray(configured)) {
    for (const entry of configured) {
      const model = normaliseModel(entry, entry?.provider);
      add(model);
    }
  }

  // Keys are the exact Ollama app/CLI cloud selectors, e.g. "gemma4:cloud".
  // Values must be the exact hosted API model IDs returned by
  // https://ollama.com/api/tags, e.g. "gemma4:31b".
  const ollamaMap = parseJson(env.OLLAMA_CLOUD_MODEL_MAP, {});
  if (env.OLLAMA_API_KEY && ollamaMap && typeof ollamaMap === "object" && !Array.isArray(ollamaMap)) {
    for (const [selector, apiModel] of Object.entries(ollamaMap)) {
      if (!/(?:^|:)cloud$/.test(selector) && !/-cloud$/.test(selector)) continue;
      if (typeof apiModel !== "string" || !apiModel.trim()) continue;
      add(normaliseModel({
        id: `ollama-cloud/${selector}`,
        apiModel: apiModel.trim(),
        label: `Ollama Cloud · ${selector}`,
        billing: "metered",
        priority: 20,
        capabilities: ["chat"],
      }, "ollama-cloud"));
    }
  }

  return models.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function getFallbackOrder(env, models) {
  const configured = parseJson(env.JARVIS_FALLBACK_ORDER, null);
  const ids = Array.isArray(configured)
    ? configured.filter((item) => typeof item === "string")
    : String(env.JARVIS_FALLBACK_ORDER || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  if (ids.length) return ids;
  return models.map((model) => model.id);
}

export function resolveCandidates(requestedModel, env, models) {
  const byId = new Map(models.map((model) => [model.id, model]));
  const fallbackMap = parseJson(env.JARVIS_MODEL_FALLBACKS, {});
  const fallbackOrder = getFallbackOrder(env, models);
  const freeOnly = requestedModel === "jarvis/free-first";
  let requested;

  if (requestedModel === "jarvis/auto" || freeOnly) {
    requested = fallbackOrder;
  } else {
    requested = [
      requestedModel,
      ...(Array.isArray(fallbackMap[requestedModel])
        ? fallbackMap[requestedModel]
        : fallbackOrder.filter((id) => id !== requestedModel)),
    ];
  }

  const candidates = [];
  const seen = new Set();
  for (const id of requested) {
    const model = byId.get(id);
    if (!model || seen.has(id)) continue;
    if (freeOnly && model.billing !== "free") continue;
    seen.add(id);
    candidates.push(model);
  }
  return candidates.slice(0, MAX_ATTEMPTS_LIMIT);
}

function providerUrl(provider, env) {
  const config = PROVIDERS[provider];
  if (!config) return null;
  if (config.cloudflare) {
    const account = encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
    return `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`;
  }
  return config.baseUrl;
}

function requestPayload(body, model) {
  const payload = {
    model: model.apiModel,
    messages: body.messages,
    stream: body.stream !== false,
  };

  const allowedOptions = [
    "temperature",
    "max_tokens",
    "top_p",
    "stop",
    "presence_penalty",
    "frequency_penalty",
    "seed",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "response_format",
  ];
  for (const key of allowedOptions) {
    if (body[key] !== undefined) payload[key] = body[key];
  }
  if (body.stream === false) payload.stream = false;
  return payload;
}

function shouldFailover(status) {
  return status === 401 || status === 402 || status === 403 ||
    status === 404 || status === 408 || status === 409 || status === 425 ||
    status === 429 || status >= 500;
}

function safeError(status) {
  if (status === 401 || status === 403) return "Provider authentication failed.";
  if (status === 402) return "Provider credits or billing limit reached.";
  if (status === 404) return "Provider model was not found or is unavailable.";
  if (status === 429) return "Provider rate limit or capacity limit reached.";
  if (status >= 500) return "AI provider is temporarily unavailable.";
  if (status === 408) return "AI provider request timed out.";
  return "AI provider rejected the request.";
}

function logAttempt(data) {
  // Never log prompts, credentials, or raw upstream error bodies.
  console.log(JSON.stringify({ service: "jarvis-router", ...data }));
}

async function callProvider(request, env, model, body, requestId) {
  const provider = model.provider;
  const config = PROVIDERS[provider];
  const baseUrl = providerUrl(provider, env);
  if (!config || !baseUrl) throw new Error("Provider configuration is invalid.");

  const timeoutMs = Math.max(5_000, Math.min(
    Number(env.UPSTREAM_TIMEOUT_MS) || 60_000,
    120_000,
  ));
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = request.signal
    ? AbortSignal.any([request.signal, timeout])
    : timeout;

  const headers = {
    "Authorization": `Bearer ${env[config.keyName]}`,
    "Content-Type": "application/json",
    "Accept": body.stream === false ? "application/json" : "text/event-stream, application/json",
    "X-Request-Id": requestId,
  };

  if (provider === "openrouter") {
    headers["HTTP-Referer"] = env.JARVIS_PUBLIC_URL || "https://jarvis.app";
    headers["X-Title"] = "JARVIS";
  }

  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(requestPayload(body, model)),
    signal,
  });
}

async function handleChat(request, env) {
  const requestId = crypto.randomUUID();
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return json({ error: { message: "Request body is too large.", type: "invalid_request_error" } }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: { message: "Expected a valid JSON request body.", type: "invalid_request_error" } }, 400);
  }

  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_BODY_BYTES) {
    return json({ error: { message: "Request body is too large.", type: "invalid_request_error" } }, 413);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_MESSAGES) {
    return json({ error: { message: `messages must contain between 1 and ${MAX_MESSAGES} entries.`, type: "invalid_request_error" } }, 400);
  }
  if (!body.messages.every((item) =>
    item && typeof item === "object" &&
    ["system", "developer", "user", "assistant", "tool"].includes(item.role) &&
    (typeof item.content === "string" || Array.isArray(item.content))
  )) {
    return json({ error: { message: "One or more messages have an invalid role or content.", type: "invalid_request_error" } }, 400);
  }

  const models = getConfiguredModels(env);
  const requestedModel = String(body.model || "").trim();
  if (!requestedModel) {
    return json({ error: { message: "A model or routing profile is required.", type: "invalid_request_error" } }, 400);
  }
  const candidates = resolveCandidates(requestedModel, env, models);
  if (candidates.length === 0) {
    return json({
      error: {
        message: requestedModel === "jarvis/free-first"
          ? "No eligible free AI models are configured and available. No paid model was used."
          : "No configured AI model is available for this request. Check provider credentials and model routing configuration.",
        type: "no_available_models",
      },
    }, 503);
  }

  const maxAttempts = Math.max(1, Math.min(
    Number(env.MAX_UPSTREAM_ATTEMPTS) || 4,
    MAX_ATTEMPTS_LIMIT,
  ));
  const tried = [];
  let lastStatus = 503;

  for (const model of candidates.slice(0, maxAttempts)) {
    const startedAt = Date.now();
    try {
      const upstream = await callProvider(request, env, model, body, requestId);
      const latencyMs = Date.now() - startedAt;

      if (!upstream.ok) {
        lastStatus = upstream.status;
        tried.push({ model: model.id, status: upstream.status });
        logAttempt({
          requestId,
          provider: model.provider,
          model: model.id,
          status: upstream.status,
          latencyMs,
          outcome: "upstream_error",
        });

        if (!shouldFailover(upstream.status)) {
          return json({
            error: {
              message: safeError(upstream.status),
              type: "provider_error",
              request_id: requestId,
              provider: model.provider,
            },
          }, upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502);
        }
        continue;
      }

      logAttempt({
        requestId,
        provider: model.provider,
        model: model.id,
        status: upstream.status,
        latencyMs,
        fallbackIndex: tried.length,
        outcome: "success",
      });

      const headers = new Headers(upstream.headers);
      headers.set("Cache-Control", "no-store");
      headers.set("X-Request-Id", requestId);
      headers.set("X-Jarvis-Provider", model.provider);
      headers.set("X-Jarvis-Model", model.id);
      headers.set("X-Jarvis-Fallback-Count", String(tried.length));
      // The upstream body is passed through untouched, preserving SSE chunks.
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch (error) {
      lastStatus = 502;
      tried.push({ model: model.id, status: "network_error" });
      logAttempt({
        requestId,
        provider: model.provider,
        model: model.id,
        latencyMs: Date.now() - startedAt,
        outcome: "network_error",
      });
      if (request.signal.aborted) {
        return json({ error: { message: "Request was cancelled.", type: "request_cancelled", request_id: requestId } }, 499);
      }
    }
  }

  return json({
    error: {
      message: `All eligible AI providers failed. Tried ${tried.length} model(s). No response was returned.`,
      type: "all_providers_failed",
      request_id: requestId,
      attempts: tried,
      last_status: lastStatus,
    },
  }, 502);
}

async function handleModels(env) {
  const models = getConfiguredModels(env).map((model) => ({
    id: model.id,
    object: "model",
    created: 0,
    owned_by: model.provider,
    name: model.label,
  }));
  const available = models.length > 0;
  const profiles = available
    ? [
        { id: "jarvis/auto", object: "model", created: 0, owned_by: "jarvis", name: "JARVIS Auto" },
        ...(getConfiguredModels(env).some((model) => model.billing === "free")
          ? [{ id: "jarvis/free-first", object: "model", created: 0, owned_by: "jarvis", name: "JARVIS Free First" }]
          : []),
      ]
    : [];
  return json({ object: "list", data: [...profiles, ...models] });
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function hasWorkersAI(env) {
  return Boolean(env.AI && typeof env.AI.run === "function");
}

async function handleTranscription(request, env) {
  if (!hasWorkersAI(env)) {
    return json({ detail: "Cloudflare Workers AI is not bound to this Worker." }, 503);
  }

  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > 8_500_000) {
    return json({ detail: "Audio upload is too large. Keep recordings under 8 MB." }, 413);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ detail: "Expected a multipart audio upload." }, 400);
  }
  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    return json({ detail: "An audio file is required." }, 400);
  }
  if (file.size <= 0 || file.size > 8_000_000) {
    return json({ detail: "Audio file must be between 1 byte and 8 MB." }, 413);
  }

  const audio = bytesToBase64(await file.arrayBuffer());
  const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
    audio,
    task: "transcribe",
  });

  const text = typeof result?.text === "string" ? result.text.trim() : "";
  if (!text) {
    return json({ detail: "The speech model did not return a transcript." }, 502);
  }
  return json({
    text,
    language: result.language || null,
    confidence: typeof result.confidence === "number" ? result.confidence : null,
    duration_seconds: Number(result.duration_seconds || result.duration || 0),
  });
}

async function handleSpeechSynthesis(request, env) {
  if (!hasWorkersAI(env)) {
    return json({ detail: "Cloudflare Workers AI is not bound to this Worker." }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ detail: "Expected a JSON speech request." }, 400);
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return json({ detail: "Speech text is required." }, 400);
  if (text.length > 5_000) {
    return json({ detail: "Speech text is limited to 5,000 characters per request." }, 413);
  }

  // The existing JARVIS page asks for bm_george. Map that legacy voice ID to
  // Aura's supported angus voice; valid Aura speaker names pass through.
  const speakers = new Set([
    "angus", "asteria", "arcas", "orion", "orpheus", "athena",
    "luna", "zeus", "perseus", "helios", "hera", "stella",
  ]);
  const requestedSpeaker = String(body.voice_id || "angus");
  const speaker = requestedSpeaker === "bm_george"
    ? "angus"
    : speakers.has(requestedSpeaker) ? requestedSpeaker : "angus";

  const audioResponse = await env.AI.run("@cf/deepgram/aura-1", {
    text,
    speaker,
    encoding: "mp3",
  }, { returnRawResponse: true });

  if (!(audioResponse instanceof Response) || !audioResponse.ok) {
    return json({ detail: "Cloudflare text-to-speech failed." }, 502);
  }

  const headers = new Headers(audioResponse.headers);
  headers.set("Content-Type", "audio/mpeg");
  headers.set("Cache-Control", "no-store");
  return new Response(audioResponse.body, {
    status: audioResponse.status,
    headers,
  });
}

async function handleOllamaCatalog(env) {
  if (!env.OLLAMA_API_KEY) {
    return json({ error: { message: "OLLAMA_API_KEY is not configured.", type: "provider_not_configured" } }, 503);
  }
  const response = await fetch("https://ollama.com/api/tags", {
    headers: { Authorization: `Bearer ${env.OLLAMA_API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    return json({ error: { message: safeError(response.status), type: "provider_error" } }, 502);
  }
  const data = await response.json();
  const items = Array.isArray(data.models) ? data.models : [];
  return json({
    provider: "ollama-cloud",
    note: "These are direct API model identifiers. Map an Ollama :cloud selector to an exact identifier here; do not strip the suffix automatically.",
    models: items.map((item) => ({
      id: String(item.name || ""),
      modified_at: item.modified_at || null,
      size: Number(item.size || 0),
    })).filter((item) => item.id),
    configured_aliases: parseJson(env.OLLAMA_CLOUD_MODEL_MAP, {}),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), request, env);
    }

    if (method === "GET" && url.pathname === "/health") {
      return withCors(json({ ok: true, service: "jarvis-ai-router" }), request, env);
    }

    if (!(await isAuthorized(request, env))) {
      const status = env.JARVIS_ACCESS_TOKEN ? 401 : 503;
      return withCors(json({
        error: {
          message: status === 401
            ? "A valid JARVIS access token is required."
            : "JARVIS_ACCESS_TOKEN has not been configured on this Worker.",
          type: "authentication_error",
        },
      }, status), request, env);
    }

    let response;
    if (method === "GET" && url.pathname === "/v1/models") {
      response = await handleModels(env);
    } else if (method === "GET" && url.pathname === "/v1/catalog/ollama-cloud") {
      try {
        response = await handleOllamaCatalog(env);
      } catch {
        response = json({ error: { message: "Could not load the Ollama Cloud model catalogue.", type: "provider_error" } }, 502);
      }
    } else if (method === "GET" && url.pathname === "/v1/recommended-model") {
      response = json({ model: "jarvis/auto", reason: "Routes across the configured provider fallback order." });
    } else if (method === "GET" && url.pathname === "/v1/speech/health") {
      response = json({
        available: hasWorkersAI(env),
        backend: hasWorkersAI(env) ? "Cloudflare Workers AI Whisper" : undefined,
        reason: hasWorkersAI(env) ? undefined : "Workers AI binding is not configured.",
      });
    } else if (method === "GET" && url.pathname === "/v1/speech/tts/health") {
      response = json({
        available: hasWorkersAI(env),
        backend: hasWorkersAI(env) ? "Cloudflare Workers AI Deepgram Aura" : undefined,
        reason: hasWorkersAI(env) ? undefined : "Workers AI binding is not configured.",
      });
    } else if (method === "POST" && url.pathname === "/v1/speech/transcribe") {
      try {
        response = await handleTranscription(request, env);
      } catch (error) {
        logAttempt({ requestId: crypto.randomUUID(), capability: "speech-to-text", outcome: "error" });
        response = json({ detail: "Speech transcription failed. Check the Workers AI binding and audio format." }, 502);
      }
    } else if (method === "POST" && url.pathname === "/v1/speech/synthesize") {
      try {
        response = await handleSpeechSynthesis(request, env);
      } catch (error) {
        logAttempt({ requestId: crypto.randomUUID(), capability: "text-to-speech", outcome: "error" });
        response = json({ detail: "Speech synthesis failed. Check the Workers AI binding." }, 502);
      }
    } else if (method === "GET" && url.pathname === "/v1/health") {
      response = json({
        ok: true,
        service: "jarvis-ai-router",
        configured_models: getConfiguredModels(env).length,
        speech_to_text: hasWorkersAI(env),
        text_to_speech: hasWorkersAI(env),
      });
    } else if (method === "POST" && url.pathname === "/v1/chat/completions") {
      response = await handleChat(request, env);
    } else {
      response = json({ error: { message: "Not found.", type: "not_found" } }, 404);
    }

    return withCors(response, request, env);
  },
};
