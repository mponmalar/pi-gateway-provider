# corp-gateway-provider

A [pi](https://github.com/badlogic/pi-mono) extension that registers your
enterprise LLM gateway as a provider. It handles gateways with the URL
pattern:

```
POST {GATEWAY_BASE_URL}/{modelId}/invoke
```

with the API key sent in the **`x-api-key`** header (the default
`Authorization: Bearer` header is stripped).

## Why an extension is required

pi's built-in streaming APIs (`openai-completions`, `anthropic-messages`, …)
always POST to a **fixed path** under the provider `baseUrl`
(e.g. `{base}/chat/completions`). Your gateway embeds the **model id in the
URL path** (`{base}/{model}/invoke`), which no built-in API can express —
neither `models.json` nor any settings file can. A custom `streamSimple`
in an extension is the only way to change the request URL.

This extension keeps it minimal and safe: it rewrites the URL and auth
headers, then delegates **all** request building, SSE streaming, tool-call
parsing, and usage/cost accounting to pi-ai's built-in
`openai-completions` implementation.

> **Assumption:** the gateway speaks an OpenAI Chat Completions compatible
> wire format (JSON request body, `text/event-stream` chunks with
> `choices[].delta`). If your gateway uses a different request/response
> schema (e.g. Bedrock-style `InvokeModel`, raw JSON non-streaming), the
> `streamGateway`/`gatewayFetch` functions need adapting — see
> `docs/custom-provider.md` → "Custom Streaming API" in the pi docs.

## One-time environment setup

Set these environment variables **once** (e.g. in `~/.bashrc` / `~/.zshenv`,
a dotfiles repo, or your org's env management), then open a new shell:

```bash
# 1. (required) Gateway base URL — no trailing slash
export GATEWAY_BASE_URL="https://llm-gateway.corp.example.com"

# 2. (required) Your gateway API key — sent as the x-api-key header
export GATEWAY_API_KEY="<your-gateway-key>"

# 3. (optional) Model list + params — JSON array, one object per model.
#    If unset, the DEFAULT_MODELS list in the extension is used.
export GATEWAY_MODELS='[
  {
    "id": "claude-sonnet-4-5",
    "name": "Sonnet 4.5 (GW)",
    "reasoning": true,
    "input": ["text", "image"],
    "contextWindow": 200000,
    "maxTokens": 16384,
    "cost": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
  },
  {
    "id": "gpt-4o",
    "name": "GPT-4o (GW)",
    "reasoning": false,
    "input": ["text", "image"],
    "contextWindow": 128000,
    "maxTokens": 16384
  }
]'
```

### Env variables

| Variable | Required | Description |
|---|---|---|
| `GATEWAY_BASE_URL` | **yes** | Gateway base URL. Requests go to `{GATEWAY_BASE_URL}/{model id}/invoke`. |
| `GATEWAY_API_KEY` | **yes** | Gateway API key, sent on every request as the `x-api-key` header. |
| `GATEWAY_MODELS` | no | JSON array of models to register (see parameters below). Falls back to the built-in list in the extension when unset or invalid. |

### Per-model parameters (`GATEWAY_MODELS` array items)

| Field | Required | Type / Default | Description |
|---|---|---|---|
| `id` | **yes** | string | Model identifier. Used in the request URL (`/{id}/invoke`) and in `/model` selection (`corp-gateway/{id}`). |
| `name` | no | string, default `id` | Human-readable label shown in pi's model lists. |
| `reasoning` | no | bool, default `false` | Whether the model supports extended thinking (thinking levels appear in the UI when true). |
| `input` | no | array, default `["text"]` | Supported input types: `"text"`, and `"image"` if the gateway accepts image inputs. |
| `contextWindow` | no | number, default `128000` | Max context size in tokens — set this to the gateway's limit so pi compacts before overflow. |
| `maxTokens` | no | number, default `16384` | Max output tokens per response. |
| `cost` | no | object, all zeros | Pricing per **million** tokens: `{ "input": n, "output": n, "cacheRead": n, "cacheWrite": n }`. Use real prices if the gateway reports usage, so pi's cost tracking is meaningful; leave unset for internal/free models. |

> Tip: keep `GATEWAY_MODELS` on one line per model or as a single compact
> line when placing it in a shared env file — it must be valid JSON
> (double quotes, no trailing commas, no comments). Verify with:
> `echo "$GATEWAY_MODELS" | python3 -m json.tool`

## Try it once (no install)

```bash
# env vars from the one-time setup above must be exported in this shell
pi -e ./gateway-provider/extensions/gateway-provider.ts
# then: /model  →  pick a "corp-gateway" model
```

## Install per user (global)

```bash
mkdir -p ~/.pi/agent/extensions
cp -r gateway-provider ~/.pi/agent/extensions/corp-gateway-provider
```

Auto-discovered from `~/.pi/agent/extensions/*/index.ts` or
`~/.pi/agent/extensions/*.ts`. (If copying the package dir, pi loads the
conventional `extensions/` directory; you can also just copy the single
`gateway-provider.ts` file.)

## Install per project (team-shared, committed to git)

```bash
mkdir -p .pi/extensions
cp gateway-provider/extensions/gateway-provider.ts .pi/extensions/
```

Project-local extensions load once the project is trusted. Team members
still need the env vars (via their shell profile, SSO wrapper, etc.).

## Install org-wide as a pi package (recommended for enterprises)

Publish the `gateway-provider/` directory to your internal npm registry or
a git repo, then:

```bash
# one-time, per user (writes to ~/.pi/agent/settings.json):
pi install git:gitlab.corp.example.com/ai-tools/pi-gateway-provider@v1
# or internal npm:
pi install npm:@corp/pi-gateway-provider@1.0.0
```

Or make it project-scoped so it auto-installs for everyone in the repo:

```bash
pi install -l git:gitlab.corp.example.com/ai-tools/pi-gateway-provider@v1
# writes to .pi/settings.json; commit it — pi installs the package
# automatically on startup after the project is trusted.
```

Verify with `pi list`.

## Verifying

```bash
pi --list-models | grep corp-gateway
pi -p "hello" --model corp-gateway/<model-id>
```

## Troubleshooting

- **Provider not registered** → `GATEWAY_BASE_URL` not set (a warning is
  printed at startup).
- **401/403** → key is wrong, or your gateway *also* wants
  `Authorization: Bearer`; remove the `headers.delete("authorization")`
  line in `gatewayFetch()`.
- **404** → path pattern differs (e.g. `/v1/models/{id}/invoke`); adjust
  `url.pathname` in `gatewayFetch()`.
- **Streaming errors / garbled output** → gateway is not OpenAI-compatible;
  implement a full custom `streamSimple` per pi's custom-provider docs.
- **Context-overflow recovery not triggering** → add your gateway's
  overflow error phrase to `OVERFLOW_PATTERNS` in the extension.
