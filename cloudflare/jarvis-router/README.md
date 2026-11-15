# JARVIS Cloud AI Router

A small Cloudflare Worker that gives the JARVIS frontend one OpenAI-compatible API while routing requests to configured hosted AI providers. It is designed for iPhone-only use: model inference runs at the providers, not on the phone or a user-owned computer.

## What is implemented

- `POST /v1/chat/completions` — OpenAI-compatible chat endpoint with SSE passthrough.
- `GET /v1/models` — configured provider models plus `jarvis/auto` and `jarvis/free-first` routing profiles.
- `GET /v1/health` and `GET /health`.
- `GET /v1/recommended-model`.
- `GET /v1/catalog/ollama-cloud` — authenticated catalogue lookup using the configured Ollama Cloud key.
- `POST /v1/speech/transcribe` — Whisper speech-to-text for the existing iPhone push-to-talk UI.
- `POST /v1/speech/synthesize` — Deepgram Aura text-to-speech returning MP3 audio.
- `GET /v1/speech/health` and `/v1/speech/tts/health`.
- Bearer-token authentication, CORS, request-size validation, upstream timeouts, structured logs, and bounded failover.

Initial chat provider adapters: Ollama Cloud, Cloudflare Workers AI, OpenAI, OpenRouter, Groq, Cerebras, Mistral, Together AI, DeepSeek, Gemini, xAI (Grok), Hugging Face Inference Providers, Fireworks AI, NVIDIA NIM, and SambaNova. A provider only appears when its server-side credential is configured and at least one model is registered. Speech uses the Cloudflare Workers AI binding configured in `wrangler.toml`.

## Important: Ollama `:cloud` aliases

In the Ollama app/CLI, cloud models are selected with names such as `gemma4:cloud`. Direct calls to `https://ollama.com/v1` require the hosted API model identifier returned by `https://ollama.com/api/tags` (Ollama's documentation gives `gemma4:31b` as an example). Do not simply remove the `:cloud` suffix.

The Worker uses `OLLAMA_CLOUD_MODEL_MAP` to preserve the model name shown in the JARVIS picker while sending the exact hosted API ID upstream:

```json
{
  "gemma4:cloud": "gemma4:31b"
}
```

The example mapping reflects Ollama's documented naming example. Verify the model is available to your own account before using it.

To inspect your account's hosted API model identifiers:

```bash
curl https://ollama.com/api/tags \
  -H "Authorization: Bearer $OLLAMA_API_KEY"
```

## Deploy

### Deploy from GitHub (recommended for iPhone-only setup)

The repository includes `.github/workflows/deploy-jarvis-router.yml`. It runs tests and a Wrangler dry-run on pushes to `feature/jarvis-voice-mode`. It deploys the Worker only after both GitHub repository secrets below are configured:

- `CLOUDFLARE_API_TOKEN` — an account API token with **Workers Editor** permission (and permission to create a Worker the first time, if it does not exist).
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID.

Create the token in Cloudflare Dashboard → Manage Account → Account API tokens. Use a narrowly scoped Workers permission. Add both values in GitHub → OpenJarvis → Settings → Secrets and variables → Actions → New repository secret. Cloudflare documents this GitHub Actions flow in its [Workers CI/CD guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) and [Workers permissions guide](https://developers.cloudflare.com/workers/authorization/workers/).

After those two secrets are saved, the next push to the router folder deploys the Worker automatically. This workflow does not set provider API keys or `JARVIS_ACCESS_TOKEN`; configure those separately as Worker secrets in Cloudflare Dashboard → Workers & Pages → `jarvis-ai-router` → Settings → Variables and Secrets.

### Manual deploy (alternative)

Run these commands from this directory on a computer with Node.js 22+ and Wrangler:

```bash
npm install
npm test
npx wrangler login
npx wrangler secret put JARVIS_ACCESS_TOKEN
npx wrangler secret put OLLAMA_API_KEY
npm run deploy
```

`JARVIS_ACCESS_TOKEN` is a private password shared only between your JARVIS browser and Worker. In the OpenJarvis Settings page, set **API URL** to the deployed Worker URL and **API key** to the same token. The existing frontend already sends its configured API key as a Bearer token to `/v1/*` endpoints.

Never put provider API keys in frontend environment variables or browser code. They belong in Worker secrets.

### Optional provider secrets

Only configure the providers you actually intend to use:

| Provider | Worker secret | Fixed upstream |
|---|---|---|
| Ollama Cloud | `OLLAMA_API_KEY` | `https://ollama.com/v1` |
| Cloudflare Workers AI | `CLOUDFLARE_AI_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account AI endpoint |
| OpenAI | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| OpenRouter | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| Groq | `GROQ_API_KEY` | `https://api.groq.com/openai/v1` |
| Cerebras | `CEREBRAS_API_KEY` | `https://api.cerebras.ai/v1` |
| Mistral | `MISTRAL_API_KEY` | `https://api.mistral.ai/v1` |
| Together AI | `TOGETHER_API_KEY` | `https://api.together.xyz/v1` |
| DeepSeek | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` |\n| Gemini | `GEMINI_API_KEY` | `https://generativelanguage.googleapis.com/v1beta/openai` |\n| xAI / Grok | `XAI_API_KEY` | `https://api.x.ai/v1` |\n| Hugging Face | `HF_TOKEN` | `https://router.huggingface.co/v1` |\n| Fireworks AI | `FIREWORKS_API_KEY` | `https://api.fireworks.ai/inference/v1` |\n| NVIDIA NIM | `NVIDIA_API_KEY` | `https://integrate.api.nvidia.com/v1` |\n| SambaNova | `SAMBANOVA_API_KEY` | `https://api.sambanova.ai/v1` |

For Cloudflare Workers AI, create an API token with the required Workers AI permissions and set your account ID as a secret as well.

Example:

```bash
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put XAI_API_KEY
npx wrangler secret put HF_TOKEN
npx wrangler secret put FIREWORKS_API_KEY
npx wrangler secret put NVIDIA_API_KEY
npx wrangler secret put SAMBANOVA_API_KEY
npx wrangler secret put CLOUDFLARE_AI_TOKEN
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

### Register models

Set `JARVIS_MODELS` in `wrangler.toml` (or as a Worker variable) to a JSON array. Only add model IDs currently supported by the upstream provider:

```json
[
  {
    "id": "openrouter/PROVIDER/MODEL",
    "provider": "openrouter",
    "apiModel": "PROVIDER/MODEL",
    "label": "Provider model via OpenRouter",
    "billing": "metered",
    "priority": 30,
    "capabilities": ["chat"]
  },
  {
    "id": "workers-ai/@cf/OWNER/MODEL",
    "provider": "workers-ai",
    "apiModel": "@cf/OWNER/MODEL",
    "label": "Workers AI model",
    "billing": "metered",
    "priority": 40,
    "capabilities": ["chat"]
  }
]
```

These are configuration examples, not guarantees that the illustrative model IDs are currently available. Verify model IDs and provider terms before registering them.

The Ollama entries are generated from `OLLAMA_CLOUD_MODEL_MAP` when `OLLAMA_API_KEY` is configured. Add their aliases to the fallback order, e.g.:

```json
[
  "ollama-cloud/gemma4:cloud",
  "openrouter/PROVIDER/MODEL",
  "workers-ai/@cf/OWNER/MODEL"
]
```

`billing` must be set explicitly to `free`, `metered`, or `paid`. Unknown billing status is excluded from `jarvis/free-first`. Ollama Cloud is marked `metered`; it is not automatically treated as free just because a subscription tier costs $0.

## Deploy the frontend to Cloudflare Pages

The existing React/Vite frontend lives in `frontend/`. In Cloudflare Dashboard → Workers & Pages → Create application → Pages → Connect to Git, select this repository and choose `feature/jarvis-voice-mode` as the production branch.

Use these build settings:

| Setting | Value |
|---|---|
| Root directory | `frontend` |
| Framework preset | `Vite` |
| Build command | `npm ci && npm run build` |
| Build output directory | `dist` |
| Node.js version | `22` |

The frontend's existing connection settings let you enter the Worker URL and access token from the iPhone. Alternatively, set the public build variable `VITE_API_URL` to the deployed Worker origin (no trailing `/v1`). Never put provider API keys or `JARVIS_ACCESS_TOKEN` in a `VITE_*` variable because Vite embeds those values into public browser code.

Cloudflare Pages Git integration builds and deploys on pushes to the selected production branch and creates preview deployments for other branches. See the [Cloudflare Pages Git integration guide](https://developers.cloudflare.com/pages/get-started/git-integration/). The first deploy creates a public `*.pages.dev` hostname.

## Frontend connection

In OpenJarvis → Settings → Connection:

- API URL: `https://jarvis-ai-router.<your-workers-subdomain>.workers.dev`
- API key: the exact value configured as `JARVIS_ACCESS_TOKEN`.

The URL must not include a trailing `/v1`; the existing frontend adds API paths itself.

For production, change `JARVIS_ALLOWED_ORIGINS` from `*` to the exact Pages origin, for example `https://<your-project>.pages.dev`. The Worker still requires the bearer token on all `/v1/*` endpoints.

## Speech cost and limits

Cloudflare Workers AI includes a limited free allocation of 10,000 Neurons per day. Usage beyond that allocation is billed on Workers Paid; on Workers Free, further inference requests fail after the daily allocation. Current published unit prices list Whisper-large-v3-turbo at about $0.0005 per audio minute and Deepgram Aura-1 at $0.015 per 1,000 input characters. Prices can change, so check [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) before enabling a paid plan. This is not unlimited free voice usage.

## Current scope / known limitations

- Failover occurs only while an upstream has not returned a successful response. Once an SSE stream has begun, the Worker passes it through and cannot transparently switch providers mid-answer.
- Speech is currently routed through Cloudflare Workers AI: Whisper large-v3-turbo for transcription and Deepgram Aura-1 for synthesis. The existing `bm_george` voice ID is mapped to Aura's supported `angus` speaker; this is not a voice-cloning or exact voice match.
- Provider usage and latency are written to Worker logs. Durable analytics, per-account quota accounting, and a control dashboard are planned follow-ups.
- The Ollama model catalogue endpoint returns direct API identifiers. The `:cloud` display alias must be explicitly mapped to the exact identifier accepted by the direct API.