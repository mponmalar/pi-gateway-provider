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

## Configuration

| Env var | Required | Description |
|---|---|---|
| `GATEWAY_BASE_URL` | yes | Gateway base URL, e.g. `https://llm-gateway.corp.example.com` |
| `GATEWAY_API_KEY` | yes | Gateway API key (sent as `x-api-key`) |
| `GATEWAY_MODELS` | no | JSON array of models to register (see below); defaults to the built-in list in the extension |

`GATEWAY_MODELS` example:

```bash
export GATEWAY_MODELS='[
  {"id":"claude-sonnet-4-5","name":"Sonnet 4.5 (GW)","reasoning":true,"input":["text","image"],"contextWindow":200000,"maxTokens":16384},
  {"id":"gpt-4o","name":"GPT-4o (GW)","input":["text","image"],"contextWindow":128000,"maxTokens":16384}
]'
```

Only `id` is required per model. Optional: `name`, `reasoning`, `input`,
`cost` (`{input, output, cacheRead, cacheWrite}` per million tokens),
`contextWindow`, `maxTokens`.

## Try it once (no install)

```bash
export GATEWAY_BASE_URL=https://llm-gateway.corp.example.com
export GATEWAY_API_KEY=...
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
