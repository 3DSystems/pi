# GitHub Copilot "Auto" Discount — Overview for Future Agents

**Last updated:** 2026-08-27
**Branch:** `feat/copilot-auto-discount`
**Scope:** `packages/ai` only

This document explains, end-to-end, what GitHub Copilot "Auto" is, how `pi`
integrates with it, the exact data flow, every file touched, and how to test.
It is written so a fresh agent can pick up the feature without re-deriving the
design from scratch.

---

## 1. What "Auto" is (and is not)

GitHub Copilot's **"Auto"** model is **not a model**. It is a *routing + billing
wrapper*. When you select Auto in VS Code / Copilot CLI:

1. The client POSTs to `https://api.githubcopilot.com/models/session` with body
   `{ "auto_mode": { "model_hints": ["auto"] } }`, using the Copilot token as
   `Authorization: Bearer`.
2. The server responds with something like:
   ```json
   {
     "available_models": ["gpt-5.6-sol", "claude-sonnet-5", ...],
     "session_token": "...",
     "discounted_costs": { "gpt-5.6-sol": 0.2, ... }
   }
   ```
3. The client sends `session_token` as the **`Copilot-Session-Token`** header on
   every subsequent request.
4. The server routes each request to one of `available_models` and applies the
   **20–10% discount server-side**. The client never computes the discount; it
   only displays it.

**Key consequence for `pi`:** because Auto has no fixed endpoint and routing is
server-driven per request, it cannot be modeled as a normal model with a fixed
`api`/`baseUrl`. It needs special handling (see §4).

---

## 2. How `pi` talks to Copilot (background)

- `pi`'s copilot provider talks to `https://api.individual.githubcopilot.com`
  (derived from the token's `proxy-ep=...` value) using two APIs:
  - **`openai-responses`** — for gpt-5.x / grok / mai models
  - **`anthropic-messages`** — for Claude 4.x/5.x models
- `pi` already injects per-request Copilot headers via `buildCopilotDynamicHeaders`
  in `packages/ai/src/api/github-copilot-headers.ts`.
- OAuth credentials are stored in `auth.json`. During login/refresh, `pi` already
  fetched `/models` and stored `availableModelIds`.
- The auto-mode endpoint `/models/session` sits right next to `/models`.

---

## 3. Chosen approach (faithful to VS Code)

The user chose a **selectable "Auto" model in the picker** (not silently attaching
a discount header to all existing Copilot models). So:

1. A new picker entry exists — model id `auto`, provider `github-copilot`.
2. When selected, `pi` fetches `/models/session` during OAuth login/refresh and
   stores `sessionToken`, `discountedCosts`, and `sessionAvailableModels` on the
   credential.
3. On each request where the selected model is `auto`, `pi`:
   - resolves the routed model to a concrete Copilot model (from
     `sessionAvailableModels`, preferring one with a known API/endpoint),
   - sends the `Copilot-Session-Token` header,
   - dispatches through that concrete model's API (`openai-responses` or
     `anthropic-messages`) so streaming/tools keep working.

---

## 4. Architecture & data flow

```
/login or refresh
  └─ GET /models  +  POST /models/session   (best-effort)
       └─ credential { access, availableModelIds,
                       sessionToken, discountedCosts, sessionAvailableModels }

request with model.id === "auto"
  └─ Models.applyAuth / prepareRequest
       └─ resolveProviderAuth → oauth.toAuth() + oauth.toEnv()   ← NEW hook
            └─ env carries COPILOT_SESSION_TOKEN + COPILOT_AUTO_MODELS
            └─ env flows into request options.env (synchronously)
  └─ provider.stream() / streamSimple()
       └─ githubCopilotProvider wrapper intercepts model.id === "auto"
            ├─ pickConcreteModel(sessionAvailableModels, context)
            │    └─ prefer a known copilot model; vision-aware fallback
            ├─ attach "Copilot-Session-Token" header
            └─ delegate to base.stream(resolvedModel, ...)
                 └─ dispatches by resolvedModel.api (openai-responses | anthropic-messages)
```

### Why the data flows through `env`

The stream handler cannot see the stored credential directly — it only receives
the resolved request options (`apiKey`, `headers`, `env`, ...). To get the session
token + candidate models into the handler **without global mutable state**, we:

1. Added an optional **`toEnv?(credential)`** hook on the `OAuthAuth` interface
   (`packages/ai/src/auth/types.ts`).
2. Copilot's OAuth implements it (`toEnv` in the oauth file) to emit:
   - `COPILOT_SESSION_TOKEN` = the session token string
   - `COPILOT_AUTO_MODELS` = JSON.stringify(available_models)
3. `resolve.ts` calls it during auth resolution and attaches the result to the
   resolved request's `env`.
4. The provider wrapper reads these keys from `options.env`.

Because auth resolution happens *before* the provider's sync `stream()` method is
called, the wrapper can do its routing **synchronously**, matching the sync return
type of `Provider.stream()`.

---

## 5. Files changed

| File | What changed |
|------|--------------|
| `packages/ai/src/auth/types.ts` | Added optional fields to `OAuthCredential`: `sessionToken?`, `discountedCosts?`, `sessionAvailableModels?`. Added optional `toEnv?()` to `OAuthAuth`. |
| `packages/ai/src/auth/oauth/github-copilot.ts` | Added `AutoModeResponse` type + `fetchGitHubCopilotAutoMode()`; merged auto data into credentials on login & refresh; added `toEnv()` impl. |
| `packages/ai/src/auth/resolve.ts` | In `resolveStoredOAuth`, call `oauth.toEnv?.(credential)` and attach result to resolved request env. |
| `packages/ai/src/auth/helpers.ts` | Forwarded `toEnv` through the `lazyOAuth` wrapper (it was dropping it). |
| `packages/ai/src/providers/github-copilot.ts` | Added `AUTO_MODEL`, kept it in `filterModels`, added provider-level stream/streamSimple wrapper + `pickConcreteModel`. |
| `packages/ai/src/api/github-copilot-headers.ts` | `buildCopilotDynamicHeaders` accepts optional `sessionToken` and injects `Copilot-Session-Token`. |
| `packages/ai/test/github-copilot-oauth.test.ts` | New test asserting `/models/session` data lands on credential; updated expected available lists to include `auto`. |
| `packages/ai/test/copilot-auto-stream.test.ts` | New: asserts auto routes to a concrete model, sends header, streams text; plus header builder unit tests. |

---

## 6. Key implementation details

### The AUTO_MODEL catalog entry (`github-copilot.ts`)
```ts
const AUTO_MODEL: Model<CopilotApi> = {
  id: "auto",
  name: "Copilot Auto",
  api: "openai-responses",   // placeholder — never dispatched on directly
  provider: "github-copilot",
  baseUrl: "https://api.individual.githubcopilot.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
  headers: {},
};
```
It is **appended at provider construction** (`[...Object.values(GITHUB_COPILOT_MODELS), AUTO_MODEL]`)
rather than added to generated model data — this keeps codegen intact.

### filterModels keeps auto always selectable
```ts
filterModels: (models, credential) => {
  // ... existing filter ...
  const concrete = models.filter((model) => model.id !== "auto" && available.has(model.id));
  return [AUTO_MODEL, ...concrete]; // auto is always kept
}
```

### Routing wrapper (`resolveAuto`)
Only triggers when `model.id === "auto" && model.provider === "github-copilot"`.
Reads env keys, picks concrete model, sets header, delegates:
```ts
stream(model, context, options) {
  const resolved = resolveAuto(model, context, options);
  if (!resolved) return base.stream(model, context, options);
  return base.stream(resolved.model, context, resolved.options as StreamOptions);
}
```
(Same pattern for `streamSimple`.)

**Keep the auth-derived base URL.** `applyAuth` (in `models.ts`) overrides the
request model's `baseUrl` with the endpoint derived from the token's `proxy-ep`
(enterprise vs individual). When `resolveAuto` substitutes the concrete catalog
model, it must preserve that: catalog models hardcode
`https://api.individual.githubcopilot.com`, and discarding the auth-derived URL
redirects enterprise requests to the individual host → **421 Misdirected
Request**. The resolved model is built as `{ ...concrete, baseUrl: model.baseUrl }`
so routing always targets the same proxy the concrete models use.

### Error handling (matches design doc)
- `/models/session` failure → `.catch(() => null)` → no auto data; falls back to
  non-discounted dispatch. **Never hard-fails login/refresh.**
- No known endpoint among candidates → fall back to pi's default copilot model.
- Abort signal propagates through all fetches (`fetchGitHubCopilotAutoMode`
  passes the shared signal).
- If no session token present on a request → header omitted; still routes via a
  concrete default model.

---

## 7. How to test

Requires Node ≥22.19 (project engine). If system node is old (e.g. v20), use:
```bash
export PATH="$HOME/.n/bin:$PATH"   # n-installed node 22.x
```

Run the copilot suites:
```bash
cd packages/ai && npx vitest --run \
  test/github-copilot-oauth.test.ts \
  test/copilot-auto-stream.test.ts \
  test/github-copilot-anthropic.test.ts
```

Typecheck:
```bash
cd /home/labfab/code/sandbox/pi-mono && npx tsgo --noEmit
```

Lint (biome):
```bash
npx biome check packages/ai/src/auth/types.ts packages/ai/src/auth/resolve.ts \
  packages/ai/src/auth/helpers.ts packages/ai/src/auth/oauth/github-copilot.ts \
  packages/ai/src/providers/github-copilot.ts packages/ai/src/api/github-copilot-headers.ts \
  packages/ai/test/github-copilot-oauth.test.ts packages/ai/test/copilot-auto-stream.test.ts
```

Full unit suite (excludes live-network E2E tests):
```bash
cd packages/ai && npx vitest --run \
  --exclude test/anthropic-eager-tool-input-e2e.test.ts \
  --exclude test/anthropic-long-cache-retention-e2e.test.ts \
  --exclude test/openai-responses-tool-result-images.test.ts \
  --exclude test/responseid.test.ts \
  --exclude test/stream.test.ts \
  --exclude test/tokens.test.ts \
  --exclude test/tool-call-without-result.test.ts \
  --exclude test/total-tokens.test.ts \
  --exclude test/unicode-surrogate.test.ts \
  --exclude test/context-overflow.test.ts \
  --exclude test/image-tool-result.test.ts
```

> **Note on E2E failures:** several test files hit the *live* GitHub Copilot API
> and fail with **421 Misdirected Request** in this environment (no real Copilot
> credentials / proxy). These failures are **pre-existing and unrelated** — they
> fail identically on the clean base commit (verified via `git stash`). They are:
> responseid, stream, tokens, tool-call-without-result, total-tokens,
> unicode-surrogate, context-overflow, image-tool-result,
> openai-responses-tool-result-images, anthropic-eager-tool-input-e2e,
> anthropic-long-cache-retention-e2e.

---

## 8. Definition of Done (all verified)

- [x] Selecting model id `auto` under provider `github-copilot` routes requests through a concrete Copilot model.
- [x] Requests carry the `Copilot-Session-Token` header.
- [x] Credential stores sessionToken + discountedCosts and persists across restarts.
- [x] All new + existing copilot tests pass.
- [x] Typecheck passes.

---

## 9. Out of scope (YAGNI — intentionally not done)

- No user-facing toggle/config — always-on when Auto is selected.
- No client-side discount display in the footer (server applies it; we just get it).
- No changes to non-copilot providers.
- No changes to generated model data / codegen.
