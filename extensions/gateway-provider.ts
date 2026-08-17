/**
 * Corp Gateway Provider for pi
 * ============================
 *
 * Registers a custom provider for an enterprise LLM gateway that exposes
 * per-model "invoke" endpoints:
 *
 *     POST {GATEWAY_BASE_URL}/{modelId}/invoke
 *
 * - Auth: the gateway's API key is sent in the `x-api-key` header
 *   (the default `Authorization: Bearer` header is stripped).
 * - Wire format: assumes the gateway speaks OpenAI Chat Completions
 *   compatible request bodies and SSE streaming chunks (the common case
 *   for LLM gateways). All request building, streaming, tool-call
 *   parsing, usage/cost tracking and error handling is delegated to
 *   pi-ai's built-in openai-completions implementation — only the URL
 *   and auth headers are rewritten.
 *
 * Configuration (environment variables):
 *   GATEWAY_BASE_URL   (required) e.g. https://llm-gateway.corp.example.com
 *   GATEWAY_API_KEY    (required) your gateway API key
 *   GATEWAY_MODELS     (optional) JSON array of models to register, e.g.
 *     '[{"id":"claude-sonnet-4-5","name":"Sonnet 4.5 (GW)","reasoning":true,
 *        "input":["text","image"],"contextWindow":200000,"maxTokens":16384}]'
 *     Optional fields: name, reasoning, input, cost, contextWindow, maxTokens.
 *
 * If GATEWAY_MODELS is not set, the DEFAULT_MODELS list below is used.
 *
 * Usage:
 *   pi -e ./extensions/gateway-provider.ts      (quick test)
 *   # or install the package (see README.md), then:
 *   /model  -> pick a "corp-gateway" model
 */

import {
	type Api,
	type AssistantMessageEventStream,
	openAICompletionsApi,
	type Context,
	type FetchFunction,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "corp-gateway";

const GATEWAY_BASE_URL = (process.env.GATEWAY_BASE_URL ?? "").replace(/\/+$/, "");

// =============================================================================
// Model list
// =============================================================================

interface GatewayModelConfig {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
}

/** Fallback model list — replace with your gateway's models or use GATEWAY_MODELS. */
const DEFAULT_MODELS: GatewayModelConfig[] = [
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5 (Gateway)",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 200000,
		maxTokens: 16384,
	},
	{
		id: "gpt-4o",
		name: "GPT-4o (Gateway)",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 128000,
		maxTokens: 16384,
	},
];

function loadModels(): GatewayModelConfig[] {
	const raw = process.env.GATEWAY_MODELS;
	if (!raw) return DEFAULT_MODELS;
	try {
		const parsed = JSON.parse(raw) as GatewayModelConfig[];
		if (!Array.isArray(parsed) || parsed.length === 0) {
			throw new Error("must be a non-empty array");
		}
		return parsed;
	} catch (error) {
		console.error(
			`[corp-gateway] GATEWAY_MODELS is not a valid JSON array (${(error as Error).message}); using built-in model list`,
		);
		return DEFAULT_MODELS;
	}
}

// =============================================================================
// Gateway fetch: rewrite URL to {base}/{model}/invoke + x-api-key header
// =============================================================================

function gatewayFetch(modelId: string, apiKey: string): FetchFunction {
	return async (input, init) => {
		const rawUrl =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: (input as { url?: string }).url ?? String(input);

		const url = new URL(rawUrl);
		// The built-in client requests {base}/chat/completions;
		// the gateway expects {base}/{modelId}/invoke.
		url.pathname = `/${modelId}/invoke`;

		const headers = new Headers(init?.headers);
		headers.set("x-api-key", apiKey);
		headers.delete("authorization"); // gateway authenticates via x-api-key only

		return fetch(url.toString(), { ...init, headers });
	};
}

// =============================================================================
// Stream function: delegate to built-in OpenAI-compatible streaming
// =============================================================================

function streamGateway(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const apiKey = options?.apiKey;
	if (!GATEWAY_BASE_URL) {
		throw new Error("GATEWAY_BASE_URL is not set (e.g. export GATEWAY_BASE_URL=https://llm-gateway.corp.example.com)");
	}
	if (!apiKey) {
		throw new Error("No API key for corp-gateway. Set GATEWAY_API_KEY or run /login corp-gateway");
	}

	return openAICompletionsApi().streamSimple(model as Model<"openai-completions">, context, {
		...options,
		headers: { ...options?.headers, "x-api-key": apiKey },
		fetch: gatewayFetch(model.id, apiKey),
	});
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI) {
	if (!GATEWAY_BASE_URL) {
		console.error(
			"[corp-gateway] GATEWAY_BASE_URL is not set — provider not registered.\n" +
				"                Example: export GATEWAY_BASE_URL=https://llm-gateway.corp.example.com",
		);
		return;
	}

	pi.registerProvider(PROVIDER_ID, {
		name: "Corp Gateway",
		baseUrl: GATEWAY_BASE_URL,
		apiKey: "$GATEWAY_API_KEY",
		api: "openai-completions",
		models: loadModels().map((m) => ({
			id: m.id,
			name: m.name ?? m.id,
			reasoning: m.reasoning ?? false,
			input: m.input ?? ["text"],
			cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: m.contextWindow ?? 128000,
			maxTokens: m.maxTokens ?? 16384,
		})),
		streamSimple: streamGateway,
	});

	// Normalize gateway-specific overflow errors so pi's automatic
	// compact-and-retry recovery kicks in when the context window is exceeded.
	const OVERFLOW_PATTERNS = [
		/maximum context length/i,
		/context length exceeded/i,
		/prompt is too long/i,
		/too many tokens/i,
	];

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "error") return;
		if (message.provider !== PROVIDER_ID && ctx.model?.provider !== PROVIDER_ID) return;
		const errorMessage = message.errorMessage ?? "";
		if (errorMessage.includes("context_length_exceeded")) return;
		if (!OVERFLOW_PATTERNS.some((p) => p.test(errorMessage))) return;

		return {
			message: { ...message, errorMessage: `context_length_exceeded: ${errorMessage}` },
		};
	});
}
