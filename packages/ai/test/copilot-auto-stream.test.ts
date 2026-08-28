import { describe, expect, it, vi } from "vitest";
import { buildCopilotDynamicHeaders } from "../src/api/github-copilot-headers.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { githubCopilotProvider } from "../src/providers/github-copilot.ts";
import type { Context } from "../src/types.ts";

type CapturedHeaders = Headers | string[][] | Record<string, string | readonly string[]> | undefined;

function getHeader(headers: CapturedHeaders, name: string): string | null {
	if (!headers) return null;
	const h = headers instanceof Headers ? headers : new Headers(headers);
	return h.get(name);
}

function responsesSse(): Response {
	const body = [
		`data: ${JSON.stringify({
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		})}`,
		`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello" }],
			},
		})}`,
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				status: "completed",
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					total_tokens: 15,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		})}`,
	].join("\n\n");

	return new Response(`${body}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("GitHub Copilot Auto routing", () => {
	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	const testAccess = "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;";

	function buildModels() {
		const store = new InMemoryCredentialStore();
		const models = createModels({ credentials: store });
		models.setProvider(githubCopilotProvider());
		return { store, models };
	}

	function captureFetch() {
		const captured = {
			headers: undefined as CapturedHeaders,
			body: null as unknown,
			url: "" as string,
			calls: 0,
		};
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
			captured.calls += 1;
			captured.url = String(_input);
			captured.headers = init?.headers;
			captured.body = init?.body;
			return responsesSse();
		});
		vi.stubGlobal("fetch", fetchMock);
		return captured;
	}

	function setupCredential(
		store: InMemoryCredentialStore,
		extra?: {
			sessionToken?: string;
			sessionAvailableModels?: string[];
			testAccess?: string;
		},
	) {
		return store.modify("github-copilot", async () => ({
			type: "oauth" as const,
			access: extra?.testAccess ?? testAccess,
			refresh: "ghu_refresh_token",
			expires: Date.now() + 60 * 60 * 1000,
			sessionToken: extra?.sessionToken ?? "sess-token-123",
			sessionAvailableModels: extra?.sessionAvailableModels ?? ["gpt-5.6-sol"],
		}));
	}

	it("routes an auto request to a concrete model and sends the Copilot-Session-Token header", async () => {
		const { store, models } = buildModels();
		await setupCredential(store, {
			sessionToken: "sess-token-123",
			sessionAvailableModels: ["gpt-5.6-sol"],
		});

		const autoModel = models.getModel("github-copilot", "auto");
		expect(autoModel).toBeDefined();
		if (!autoModel) return;

		const captured = captureFetch();

		const result = await models.completeSimple(autoModel, context);

		const payload = JSON.parse(String(captured.body)) as { model?: string };
		const requestedModel = payload.model;

		// Resolves to the server-provided concrete model (gpt-5.6-sol), not literally "auto".
		expect(requestedModel).toBe("gpt-5.6-sol");

		// Carries the Copilot-Session-Token header on the outgoing request.
		expect(getHeader(captured.headers, "Copilot-Session-Token")).toBe("sess-token-123");

		// Streaming completes normally with text.
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		expect(text).toContain("Hello");
	});

	it("routes to the auth-derived proxy endpoint, not the hardcoded individual host", async () => {
		const { store, models } = buildModels();
		await setupCredential(store, {
			sessionToken: "sess-token-123",
			sessionAvailableModels: ["gpt-5.6-sol"],
			testAccess: "tid=test;exp=9999999999;proxy-ep=proxy.enterprise.githubcopilot.com;",
		});

		const autoModel = models.getModel("github-copilot", "auto");
		expect(autoModel).toBeDefined();
		if (!autoModel) return;

		const captured = captureFetch();

		await models.completeSimple(autoModel, context);

		// The request must go to the enterprise host derived from the token's
		// proxy-ep, not the catalog default individual host (421 Misdirected).
		expect(captured.url).toContain("https://api.enterprise.githubcopilot.com");
		expect(captured.url).not.toContain("api.individual.githubcopilot.com");
	});
});

describe("buildCopilotDynamicHeaders", () => {
	it("includes Copilot-Session-Token when a session token is provided", () => {
		const headers = buildCopilotDynamicHeaders({
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			hasImages: false,
			sessionToken: "sess-token-456",
		});
		expect(headers["Copilot-Session-Token"]).toBe("sess-token-456");
	});

	it("omits Copilot-Session-Token when no session token is provided", () => {
		const headers = buildCopilotDynamicHeaders({
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			hasImages: false,
		});
		expect(headers["Copilot-Session-Token"]).toBeUndefined();
	});
});
