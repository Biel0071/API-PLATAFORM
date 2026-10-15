# Provider Account Storage and OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store multiple global connections per provider, migrate existing credentials safely, and bind supported OAuth flows to individual accounts.

**Architecture:** Keep `ProviderConfig` as the provider/model/default catalog and add `ProviderAccount` for each connection. An idempotent backfill imports existing configured rows; account CRUD and OAuth operate on that entity while the old provider-config API remains compatible during rollout.

**Tech Stack:** Node.js 22+, TypeScript, Fastify, Prisma, PostgreSQL, Redis, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-15-provider-accounts-and-platform-visual-design.md`

## Global Constraints

- As contas continuam globais para a plataforma, como a configuração atual; não passam a pertencer a tenants individuais.
- `ProviderAccount` será a fonte relacional das contas. O JSON de configurações ficará restrito a opções específicas e não secretas do provedor.
- Chaves e tokens continuarão criptografados no backend. OAuth será vinculado a uma conta individual.
- OAuth aparecerá somente para provedores com fluxo utilizável e configurado.
- A migração criará uma conta a partir de cada configuração existente que contenha uma conexão utilizável, preservando credenciais e configurações atuais.
- A migração será aditiva e idempotente.
- Uma conta desconectada será desativada e terá os segredos removidos, mantendo o registro mínimo necessário para histórico de uso.

## Review Focus

- A repeated or concurrent backfill must not duplicate an imported account (`provider-account-migration.test.ts`: run backfill twice and assert one account).
- A legacy row with encrypted API key, OAuth, or local endpoint must preserve its connection mode and provider defaults (`provider-account-migration.test.ts`: assert copied fields and unchanged `ModelConfig`).
- Two accounts for one provider may share a display name without colliding (`provider-accounts.test.ts`: create both and list both).
- An account id from another provider or an inactive account must not expose existence or secret data (`provider-accounts.test.ts`: assert safe validation response).
- OAuth state, code flow, refresh token, and disconnect must remain scoped to the initiating account (`provider-oauth.test.ts`: authorize account A and assert account B is unchanged).

---

### Task 1: Add account persistence and idempotent legacy backfill

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/main.ts` (run backfill after bootstrap creates legacy defaults and before provider runtime initialization)
- Create: `apps/api/src/services/provider-account-migration.service.ts`
- Test: `apps/api/tests/provider-account-migration.test.ts`

**Interfaces:**

- Produces `backfillLegacyProviderAccounts(): Promise<number>`.
- `ProviderAccount` stores `providerId: string`, `displayName: string`, `authMode: 'apiKey' | 'oauth' | 'local'`, `baseUrl: string | null`, non-secret `settings: Json`, `credentialEncrypted: string | null`, separately encrypted OAuth access/refresh tokens and expiry, `enabled: boolean`, `disconnectedAt: Date | null`, nullable health result/check time/latency, timestamps, and nullable unique `legacyProviderConfigId`.
- `legacyProviderConfigId` identifies the one account imported from an old provider row; new accounts leave it null.
- `ProviderAccountView` is `{ id, providerName, displayName, authMode, baseUrl, enabled, hasCredential, oauthNeedsReauth, health: { ok: boolean | null, checkedAt: string | null, latencyMs: number | null } }`; it never includes credential or token values.

- [x] **Step 1: Write failing migration tests** for API-key, OAuth, and local-server rows, absent credentials, provider defaults/model preservation, and a repeated backfill.
- [x] **Step 2: Run the focused test** with `npm test -w apps/api -- provider-account-migration.test.ts`.
      Expected: FAIL because `ProviderAccount` and `backfillLegacyProviderAccounts()` do not exist.
- [x] **Step 3: Add the Prisma model and backfill service.** Use a transaction and the unique legacy source id so concurrent execution is idempotent. Copy already-encrypted credential material without decrypting it; do not delete legacy values in this task because the current runtime still reads them.
- [ ] **Step 4: Run the idempotent backfill during API startup** after the additive schema is available and before provider runtime initialization; validate and test with `npx prisma validate --schema apps/api/prisma/schema.prisma` and the focused Vitest command; use a disposable PostgreSQL database to confirm schema push is additive. Prisma validation and the offline additive SQL diff passed; live PostgreSQL schema-push verification remains open because Docker/PostgreSQL are unavailable.
- [x] **Step 5: Commit only the task-owned diff** after inspecting staged hunks for unrelated edits.

### Task 2: Add safe account CRUD and legacy API compatibility

**Files:**

- Create: `apps/api/src/services/provider-account.service.ts`
- Create: `apps/api/src/routes/admin/provider-accounts.ts`
- Modify: `apps/api/src/routes/admin/index.ts`
- Modify: `apps/api/src/services/provider-config.service.ts`
- Modify: `apps/api/src/routes/admin/providers.ts`
- Test: `apps/api/tests/provider-accounts.test.ts`

**Interfaces:**

- Produces `createProviderAccount(input)`, `updateProviderAccount(id, input)`, `listProviderAccounts(providerName?)`, and `disconnectProviderAccount(id)`.
- `ProviderAccountInput` is `{ providerName: string; displayName: string; authMode: 'apiKey' | 'oauth' | 'local'; baseUrl?: string; apiKey?: string; settings?: Record<string, string | number | boolean> }`; `settings` is validated against the provider allowlist and rejects secret-like fields.
- `ProviderAccountView` matches the safe return shape defined in Task 1 and contains only credential-presence flags, provider identity, account status, and health metadata.
- Admin routes: `GET/POST /provider-accounts`, `PATCH/DELETE /provider-accounts/:accountId`.
- Existing `POST /provider-configs` and `GET /provider-configs` continue to map to the imported account during rollout; writes must update the corresponding `ProviderAccount`.

- [x] **Step 1: Write failing route/service tests** for create, edit, disconnect, duplicate display names, secret redaction, empty-secret preservation, and legacy endpoint compatibility.
- [x] **Step 2: Run** `npm test -w apps/api -- provider-accounts.test.ts` and confirm the new cases fail.
- [x] **Step 3: Implement the service and protected routes.** Validate provider/mode combinations with the existing provider allowlist; encrypt new secrets; preserve a saved secret when the edit omits it; soft-disconnect and erase credential material while retaining usage history.
- [x] **Step 4: Run** focused tests (35/35), the API suite (178/178), and `npx tsc -p apps/api/tsconfig.json --noEmit`.
- [ ] **Step 5: Commit only the task-owned diff** after staged-diff review.

### Task 3: Scope OAuth flows and callbacks to one account

**Files:**

- Modify: `apps/api/src/services/provider-oauth.service.ts`
- Modify: `apps/api/src/routes/admin/providers.ts`
- Modify: `apps/api/src/routes/provider-oauth-callback.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/tests/provider-oauth.test.ts`

**Interfaces:**

- OAuth start, poll, callback, and disconnect operations receive or resolve a `providerAccountId` and persist tokens only on that account.
- New account-scoped endpoints use `/provider-accounts/:accountId/oauth/...`; existing provider-only OAuth routes remain a compatibility alias for the imported legacy account until the dashboard switches.
- Hugging Face uses its device-code flow with only the `inference-api` permission. Gemini uses Google’s web-server authorization-code flow and is offered only when a public HTTPS callback URL and Google OAuth client id/secret are configured server-side; no Google device-code flow is used.
- OAuth client secrets are read from environment configuration and never sent to the browser.

- [x] **Step 1: Add failing tests** for two-account isolation, callback state bound to the account, denial, expiry, replay, refresh-token rotation, account-specific disconnect, Hugging Face’s exact minimum permission, and Gemini option availability with and without HTTPS/client configuration.
- [x] **Step 2: Run** `npm test -w apps/api -- provider-oauth.test.ts` and confirm the account-scoping cases fail.
- [x] **Step 3: Bind OAuth state and device-flow records to the account id.** Preserve existing PKCE/state, TTL, rate limits, timeouts, and log redaction; reject stale or mismatched account ids before saving tokens.
- [x] **Step 4: Run** OAuth/account tests (42/42) and the full API suite (185/185), plus API typecheck.
- [ ] **Step 5: Commit only the task-owned diff** after staged-diff review.
