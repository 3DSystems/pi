import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadGitHubCopilotOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Context, Model, SimpleStreamOptions, StreamOptions } from "../types.ts";
import { GITHUB_COPILOT_MODELS } from "./github-copilot.models.ts";

type CopilotApi = "anthropic-messages" | "openai-completions" | "openai-responses";

/** Env keys surfaced by the Copilot OAuth `toEnv` hook on every resolved request. */
const COPILOT_SESSION_TOKEN_ENV = "COPILOT_SESSION_TOKEN";
const COPILOT_AUTO_MODELS_ENV = "COPILOT_AUTO_MODELS";

/**
 * The selectable \"Auto\" pseudo-model. It has no fixed endpoint because routing
 * is server-driven per request; the provider stream wrapper resolves it to a
 * concrete Copilot model before dispatch. `api` is a placeholder (openai-responses)
 * that is never dispatched on directly — the wrapper always substitutes a real
 * concrete model first.
 */
const AUTO_MODEL: Model<CopilotApi> = {
	id: "auto",
	name: "Copilot Auto",
	api: "openai-responses",
	provider: "github-copilot",
	baseUrl: "https://api.individual.githubcopilot.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
	headers: {},
};

function isAutoModel(model: Model<CopilotApi>): boolean {
	return model.id === "auto" && model.provider === "github-copilot";
}

/**
 * Resolve the concrete Copilot model for an `auto` request using the session's
 * server-provided candidate list (`available_models`). Prefers a candidate that
 * pi knows an endpoint/API for; falls back to pi's default Copilot model.
 */
function pickConcreteModel(
	sessionAvailableModels: readonly string[] | undefined,
	context: Context,
): Model<CopilotApi> | undefined {
	const known = Object.values(GITHUB_COPILOT_MODELS) as Model<CopilotApi>[];
	const hasImages = context.messages.some((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return msg.content.some((c) => c.type === "image");
		}
		return false;
	});

	let candidates = known;
	if (sessionAvailableModels && sessionAvailableModels.length > 0) {
		const availableSet = new Set(sessionAvailableModels);
		candidates = known.filter((model) => availableSet.has(model.id));
	}
	if (candidates.length === 0) {
		candidates = known;
	}

	// Prefer a vision-capable candidate when the conversation carries images so
	// image messages still work after routing; otherwise take the first known one.
	const pick = (list: Model<CopilotApi>[]) => list.find((m) => !hasImages || m.input.includes("image")) ?? list[0];
	return pick(candidates) ?? undefined;
}

export function githubCopilotProvider(): Provider<CopilotApi> {
	const base = createProvider({
		id: "github-copilot",
		name: "GitHub Copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
		auth: {
			apiKey: envApiKeyAuth("GitHub Copilot token", ["COPILOT_GITHUB_TOKEN"]),
			oauth: lazyOAuth({ name: "GitHub Copilot", isSubscription: true, load: loadGitHubCopilotOAuth }),
		},
		models: [...Object.values(GITHUB_COPILOT_MODELS), AUTO_MODEL],
		filterModels: (models, credential) => {
			if (credential?.type !== "oauth") return models;
			const availableModelIds = credential.availableModelIds;
			if (!Array.isArray(availableModelIds) || !availableModelIds.every((id) => typeof id === "string")) {
				return models;
			}
			const available = new Set(availableModelIds);
			const concrete = models.filter((model) => model.id !== "auto" && available.has(model.id));
			// Auto is a routing entry, not a concrete account model; always keep it selectable.
			return [AUTO_MODEL, ...concrete];
		},
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});

	const resolveAuto = (
		model: Model<CopilotApi>,
		context: Context,
		options?: StreamOptions,
	): { model: Model<CopilotApi>; options?: StreamOptions } | undefined => {
		if (!isAutoModel(model)) return undefined;
		const env = options?.env;
		const sessionToken =
			typeof env?.[COPILOT_SESSION_TOKEN_ENV] === "string" ? env[COPILOT_SESSION_TOKEN_ENV] : undefined;

		let sessionAvailableModels: string[] | undefined;
		const rawAutoModels = env?.[COPILOT_AUTO_MODELS_ENV];
		if (typeof rawAutoModels === "string") {
			try {
				const parsed = JSON.parse(rawAutoModels);
				if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
					sessionAvailableModels = parsed;
				}
			} catch {
				sessionAvailableModels = undefined;
			}
		}

		const concrete = pickConcreteModel(sessionAvailableModels, context);
		if (!concrete) return undefined;

		const resolvedModel = { ...concrete };
		const headers =
			sessionToken !== undefined
				? { ...(options?.headers ?? {}), "Copilot-Session-Token": sessionToken }
				: options?.headers;

		return { model: resolvedModel, options: options ? { ...options, headers } : options };
	};

	return {
		...base,
		stream(model, context, options) {
			const resolved = resolveAuto(model, context, options);
			if (!resolved) return base.stream(model, context, options);
			return base.stream(resolved.model, context, resolved.options as StreamOptions);
		},
		streamSimple(model, context, options) {
			const resolved = resolveAuto(model, context, options);
			if (!resolved) return base.streamSimple(model, context, options);
			return base.streamSimple(resolved.model, context, resolved.options as SimpleStreamOptions);
		},
	};
}
