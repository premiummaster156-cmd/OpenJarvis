# JARVIS AI Router — OmniRoute-Inspired Architecture

Status: architecture specification
Target deployment: Cloudflare Workers + Cloudflare Pages
Client: iPhone browser / installed web app
Primary constraint: no user-owned laptop or always-on local server

## Purpose

Give JARVIS one stable AI interface while allowing it to use multiple model providers. A provider outage, exhausted quota, or timeout should not take the assistant offline if another eligible provider is available.

This design adapts architectural ideas from [OmniRoute](https://github.com/cheaper-inference/OmniRoute): a unified OpenAI-compatible API, provider adapters, ordered model combos, quota-aware selection, streaming translation, circuit breakers, account-level fallback, and usage telemetry.

OmniRoute is MIT-licensed. This document describes an independent adaptation of its documented architecture; it does not copy its source code.

## Deployment architecture

```text
iPhone JARVIS UI (Cloudflare Pages)
          |
          | HTTPS / SSE
          v
Cloudflare Worker — /v1/chat/completions
          |
          +-- Auth + request validation
          +-- JARVIS system prompt + conversation context
          +-- Router / policy engine
          |      |
          |      +-- Provider registry
          |      +-- Model aliases and task profiles
          |      +-- Fallback chain / combo resolver
          |      +-- Quota + cooldown checks
          |      +-- Circuit breaker state
          |
          +-- Provider adapters
          |      +-- Cloudflare Workers AI
          |      +-- OpenRouter
          |      +-- Groq
          |      +-- Google Gemini
          |      +-- Cerebras
          |      +-- Mistral
          |      +-- Other OpenAI-compatible endpoints
          |
          +-- SSE response normalizer
          +-- Usage / latency / failure telemetry
          |
          +-- Cloudflare D1: durable config and usage records
          +-- Cloudflare KV: cache and non-critical config
          +-- Durable Objects: coordination for shared breaker / quota state
          +-- Worker Secrets: provider credentials
```

Cloudflare services are proposed roles, not a claim that all are required on day one. Start with the Worker, Secrets, D1 and a small provider set. Add Durable Objects only where cross-request coordination is needed.

## 1. One stable API contract

The JARVIS frontend should call only our own endpoint:

- `POST /v1/chat/completions`
- `GET /v1/models`
- `GET /v1/health`
- `GET /v1/usage` (authenticated owner/admin view)

Use an OpenAI-compatible request/response shape internally. The UI must not know which upstream provider handled a request. Keep provider-specific formats inside adapters.

Support streaming with Server-Sent Events (SSE). Normalize upstream chunks into one event format, send a final completion event, and close the stream cleanly. If a provider cannot stream, adapt its completed response into the same client contract.

## 2. Provider adapter interface

Each provider adapter should implement the same conceptual operations:

- `listModels()` or use a maintained model catalogue
- `validateConfig()`
- `chat(request, options)`
- `chatStream(request, options)` when supported
- `classifyError(error)`
- `estimateCost(usage, model)` when pricing is known

An adapter owns authentication headers, URL paths, request translation, response translation, stream parsing, and provider-specific error interpretation.

Never expose provider API keys to the browser. Store secrets as Cloudflare Worker secrets, or encrypted per-user credentials if multi-user support is deliberately added later.

## 3. Provider and model registry

Represent a configured target with fields such as:

- provider ID
- model ID
- active / disabled state
- capability tags: chat, reasoning, vision, tools, audio
- free / paid classification (informational; never assume free means unlimited)
- priority and optional weight
- request timeout
- known context limit
- connection/account identifier where applicable

Do not hard-code claims that a model is free forever. Provider pricing, free quotas, and availability change; store last-verified metadata and allow the owner to disable a target.

## 4. Fallback combos and routing profiles

Create named routing profiles instead of scattering provider order throughout the app.

Initial profiles:

- `jarvis/default`: best available balance of reliability, quality and latency
- `jarvis/free-first`: eligible free-tier targets first; never silently switch to paid targets
- `jarvis/fast`: prioritize low time-to-first-token and latency
- `jarvis/reasoning`: prefer reasoning-capable models
- `jarvis/vision`: require image/vision capability
- `jarvis/backup`: conservative ordered fallback chain

A profile is a list of provider/model targets plus a strategy. Start with deterministic priority order. Add weighted, round-robin, least-used or quota-aware strategies only after telemetry exists.

Fallback must preserve the original user request and conversation context. Do not append partial failed-provider output to the next provider's prompt. If a stream has already emitted user-visible text, do not transparently restart on another provider and concatenate two answers. Either finish the stream, emit an explicit recoverable error, or restart the whole turn with a clearly signaled retry policy.

## 5. Three separate resilience layers

Keep these mechanisms distinct:

### Provider circuit breaker

Protects against repeated provider-wide failures.

States: CLOSED (normal), OPEN (skip provider temporarily), HALF_OPEN (allow a probe). Use bounded failure windows and cooldowns. Only trip on service-level failures such as repeated 5xx/timeouts, not every 401/403/429.

### Connection/account cooldown

Protects one credential or account while other accounts for that provider may remain usable. Respect upstream Retry-After/reset headers for rate limits. Use exponential backoff with a maximum cap and jitter.

### Model-specific lockout

A particular model may be unavailable or over quota while another model at the same provider still works. Track this separately from provider health.

In a stateless Worker, do not rely on process memory for durable shared state. Use D1 for durable records and consider Durable Objects for strongly coordinated counters/locks. KV is eventually consistent and should not be the sole authority for strict concurrent quota accounting.

## 6. Request policy and routing order

For every request:

1. Authenticate the JARVIS client.
2. Validate body size, model/profile, message structure and allowed capabilities.
3. Resolve the requested profile or explicit model alias.
4. Build eligible targets; filter disabled, incompatible, locked-out and disallowed paid targets.
5. Check provider breaker and connection cooldown state.
6. Choose a target using the profile strategy.
7. Call the adapter with a bounded timeout.
8. Normalize response or stream to the JARVIS API contract.
9. Classify errors and update the correct resilience layer.
10. On eligible pre-output failure, try the next target within a strict attempt/time budget.
11. Record provider, model, latency, first-token latency, token usage if supplied, fallback count and outcome.

Do not retry authentication failures indefinitely. Do not retry invalid requests or policy denials. Respect rate-limit reset hints. Use a per-request attempt cap to prevent retry storms.

## 7. Cost and free-tier safety

The `free-first` profile must have a hard no-paid-fallback rule. If all free targets are unavailable, return a clear message such as: "Free AI providers are temporarily unavailable. No paid provider was used."

Track provider usage where available, but do not pretend all upstreams report exact token counts or quotas. Distinguish provider-reported usage from estimates. Add configurable daily request/token budgets and an owner-visible kill switch.

OmniRoute's advertised combined free-tier capacity is an aggregation of separate third-party provider plans and accounts, not a free token grant from OmniRoute. JARVIS must make the same distinction.

## 8. Security

- Keep all upstream credentials server-side.
- Require an app/session token for JARVIS API calls; never publish an unrestricted proxy endpoint.
- Apply per-user and per-IP rate limits.
- Validate provider base URLs against an allowlist; block private/link-local/loopback destinations to prevent SSRF.
- Set request and response size limits and upstream timeouts.
- Redact API keys, OAuth tokens, and sensitive prompt data from logs.
- Add request IDs for end-to-end tracing.
- Do not expose raw upstream error bodies to the browser.
- Make owner-only provider configuration and usage endpoints explicit.

## 9. iPhone-only voice integration

Keep voice services behind the same provider-adapter idea, but separate them from chat routing:

- speech-to-text adapter
- text-to-speech adapter
- optional realtime speech provider adapter

The iPhone UI should stream audio to a supported backend endpoint and play returned audio. A text-model fallback does not automatically imply a speech-model fallback; each modality needs its own capability and routing policy.

A Cloudflare Worker is the control plane and request gateway, not a general-purpose always-running Python host. Do not assume it can run Ollama or arbitrary local model binaries. Since the user has no always-on computer/server, local Ollama is not a viable primary provider in this deployment.

## 10. Phased implementation

### Phase A — safe foundation
- Worker API with OpenAI-compatible request contract
- provider adapter interface
- Cloudflare Workers AI adapter
- one external OpenAI-compatible adapter
- secrets, authentication, request IDs and basic usage logging
- deterministic fallback before any stream output

### Phase B — robust routing
- provider/model registry
- named profiles and free-only mode
- provider breaker, account cooldown and model lockout
- bounded retries, Retry-After handling and fallback telemetry

### Phase C — intelligence and controls
- latency/health-aware routing
- model capability catalogue and task-fit routing
- owner dashboard for providers, priorities, budgets and health
- model evaluation before automatic quality-based routing

### Phase D — voice
- separate STT/TTS provider adapters
- audio streaming and voice fallback policies
- live voice only where browser and provider APIs support it reliably

## Important deployment boundary

This design intentionally does not transplant OmniRoute's local Next.js server, SQLite runtime, OAuth modules, or hundreds of provider executors into Cloudflare Workers. Those components are coupled to OmniRoute's own runtime. We are adopting the portable architecture and implementing a smaller Cloudflare-native router suitable for JARVIS and the user's iPhone-only setup.
