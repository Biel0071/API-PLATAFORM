# Provider Account Routing and Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route synchronous and queued inference through multiple accounts, allow an authorized caller to select an account, and record reliable per-account attempts, tokens, and estimated costs.

**Architecture:** Keep provider-level candidate resolution in `ProviderRegistry`, then expand each provider into account-specific instances through a shared account pool. API and worker runtime loaders supply account instances and an atomic Redis rotation callback. A separate `ProviderAttempt` table captures actual provider calls without changing current `RequestLog` or `Usage` behavior.

**Tech Stack:** Node.js 22+, TypeScript, Prisma, Fastify, PostgreSQL, Redis, Vitest, BullMQ.

**Spec:** `docs/superpowers/specs/2026-10-15-provider-accounts-and-platform-visual-design.md`

**Dependency:** Complete `2026-10-15-provider-account-storage-oauth.md` first.

## Global Constraints

- A API validará que a conta existe, está ativa e pertence ao provedor solicitado, e aplicará as permissões já associadas à chave ou rota autenticada; conhecer o identificador não concede acesso.
- Sem identificador explícito, o roteador escolherá contas habilitadas e saudáveis em ordem circular para distribuir carga.
- Se uma tentativa automática falhar por indisponibilidade transitória, tentará a próxima conta elegível sem repetir indefinidamente.
- Falhas de autenticação e erros de validação não provocarão alternância automática. Quando a chamada fixar uma conta, o roteador a respeitará e retornará o erro real dessa conexão, sem trocar silenciosamente de conta.
- Falhas terão mensagem segura e serão registradas sem incluir chaves, tokens, códigos OAuth ou URLs com segredos.
- Uma nova tabela `ProviderAttempt` guardará cada chamada real a um provedor nos caminhos síncronos, no `ExecutionGateway` e nos workers.
- Uma resposta do cache não criará tentativa nem será atribuída a uma conta.
- Os agregados existentes por tenant e provedor continuarão compatíveis.
- `RequestLog` e `Usage` manterão seu comportamento atual para preservar os relatórios existentes.
- O custo será calculado com as tarifas de entrada e saída por mil tokens já registradas para o modelo, e gravado como fotografia no momento da chamada para não mudar quando uma tarifa for editada.

## Review Focus

- Parallel requests across API and workers must rotate fairly without a lost or duplicated Redis counter (`provider-account-routing.test.ts`: concurrent selection test).
- An explicit account paired with a different provider, a deleted account, or an unauthorized key must fail safely without provider fallback (`provider-account-routing.test.ts`: mismatch and authorization cases).
- A 401/400 must not trigger account fallback, while a retryable 5xx advances once to the next account (`provider-account-routing.test.ts`: retry classification cases).
- A cache hit must not create `ProviderAttempt`, and account-scoped cache entries must not cross accounts (`provider-account-routing.test.ts`: cache isolation case).
- Missing token usage or price must produce unavailable metrics; configured zero-price local models must remain a real zero (`provider-attempt-usage.test.ts`: null versus zero and window-boundary cases).

---

### Task 1: Build account-specific provider instances and round-robin pool

**Files:**

- Create: `packages/shared/src/providers/account-pool.ts`
- Modify: `packages/shared/src/providers/registry.ts`
- Modify: `packages/shared/src/provider-config-env.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `apps/api/src/services/provider-account-runtime.service.ts`
- Modify: `apps/api/src/services/ai.service.ts`
- Modify: `apps/worker/src/main.ts`
- Test: `apps/api/tests/provider-account-routing.test.ts`

**Interfaces:**

- `ProviderAccountBinding`: `{ accountId: string; providerName: string; provider: AIProvider; enabled: boolean; healthOk: boolean; healthCheckedAt: Date | null }`.
- `ProviderAccountPool.resolveAccounts(providerName: string, capability: Capability, selectedAccountId?: string): Promise<ProviderAccountBinding[]>`.
- The pool receives `nextIndex(providerName, count): Promise<number>`; API and worker inject a Redis `INCR` implementation with a process-local fallback only when Redis is unavailable.
- `resolveProviderAccountTargets(capability, requestedProvider?, selectedAccountId?)` returns account-tagged targets before other-provider fallback targets; it never adds the legacy provider instance for a provider that already has account bindings.

- [x] **Step 1: Write failing pool tests** for two accounts, round-robin start position, capability filtering, stale/unhealthy accounts, explicit selection, provider mismatch, and no configured account fallback.
- [x] **Step 2: Run** `npm test -w apps/api -- provider-account-routing.test.ts` and confirm account-target tests fail.
- [x] **Step 3: Implement the shared pool and runtime loaders.** Build each configured provider instance from its own account credentials; keep provider name stable, cache instances by account id and update timestamp, refresh account data on the existing registry refresh interval, and skip duplicate legacy instances for account-backed providers.
- [x] **Step 4: Add the real account health-test operation** to `POST /admin/provider-accounts/:accountId/test`; persist health only from `provider.health()` and exclude stale/unknown accounts from automatic selection until a real check succeeds.
- [x] **Step 5: Run** focused routing tests, `npx tsc -p apps/api/tsconfig.json --noEmit`, and `npx tsc -p apps/worker/tsconfig.json --noEmit`.
- [ ] **Step 6: Commit only task-owned changes** after checking the staged diff.

### Task 2: Route every request path with explicit selection and bounded fallback

**Files:**

- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/types.ts`
- Modify: `apps/api/src/services/ai.service.ts`
- Modify: `apps/api/src/services/execution-gateway.service.ts`
- Modify: `apps/api/src/routes/v1/index.ts`
- Modify: `apps/api/src/routes/v1/openai-compat.ts`
- Modify: `apps/api/src/routes/v1/anthropic-compat.ts`
- Modify: `apps/api/src/routes/v1/decide.ts`
- Modify: `apps/api/src/routes/admin/images.ts`
- Modify: `apps/api/src/services/smart-router.service.ts`
- Modify: `apps/api/src/services/background-orchestrator.service.ts`
- Modify: `apps/worker/src/processors.ts`
- Modify: `apps/api/src/services/queue.service.ts`
- Modify: `apps/api/src/services/provider-account-migration.service.ts` (clear legacy secrets after all call paths use accounts)
- Test: `apps/api/tests/provider-account-routing.test.ts`
- Test: `apps/api/tests/multi-provider-e2e.test.ts`
- Test: `apps/api/tests/provider-account-migration.test.ts`

**Interfaces:**

- Add optional `providerAccountId?: string` to inference request contracts; pass it to execution context, not to `AIProvider` inputs.
- `ExecuteContext` carries `providerAccountId` and a stable `correlationId` for synchronous calls and queued jobs.
- `ExecutionGateway.execute` receives the selected account through its typed request/context and applies the same account rules as `ai.service.execute`.

- [ ] **Step 1: Add failing API and worker tests** for explicit account selection, provider derivation when omitted, mismatch rejection, account fallback order, bounded retryable failover, no failover on 401/400, queued payload preservation, and upstream payload redaction.
- [ ] **Step 2: Run** the focused routing and multi-provider tests and confirm the new cases fail.
- [ ] **Step 3: Update synchronous v1, OpenAI-compatible, Anthropic-compatible, decision, admin-image, smart-router, background-orchestrator, and `ExecutionGateway` paths.** Resolve the provider from an explicit account when no provider is supplied; reject conflicting provider/account pairs; do not fall back when the caller pins an account.
- [ ] **Step 4: Update queued routes and processors.** Preserve `providerAccountId` and correlation id in job payloads; have `runWithFallback` try account instances before moving to the next provider; keep rate-limit retries bounded and do not retry non-retryable errors.
- [ ] **Step 5: Isolate cache keys by explicit account** and ensure cache hits do not create attempt records or attribute spend to a connection.
- [ ] **Step 6: After all synchronous and queued paths use `ProviderAccount`, clear legacy secrets idempotently** only when the linked account is present and validated; preserve provider defaults, models, and historical logs.
- [ ] **Step 7: Test** the legacy-secret finalizer with API-key, OAuth, local-endpoint, missing-account, repeated-run, and post-cleanup runtime cases.
- [ ] **Step 8: Run** the focused tests, full API tests, and API/worker typechecks.
- [ ] **Step 9: Commit only task-owned changes** after staged-diff review.

### Task 3: Record attempts and return five-hour/seven-day account metrics

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `packages/shared/src/provider-attempt.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `apps/api/src/services/provider-attempt.service.ts`
- Create: `apps/api/src/services/provider-account-usage.service.ts`
- Modify: `apps/api/src/services/ai.service.ts`
- Modify: `apps/api/src/services/smart-router.service.ts`
- Modify: `apps/api/src/routes/v1/decide.ts`
- Modify: `apps/api/src/services/execution-gateway.service.ts`
- Modify: `apps/worker/src/processors.ts`
- Modify: `apps/api/src/routes/admin/provider-accounts.ts`
- Modify: `apps/api/src/routes/admin/observability.ts`
- Test: `apps/api/tests/provider-attempt-usage.test.ts`

**Interfaces:**

- `ProviderAttemptRecord`: `{ correlationId: string; executionId: string; attemptNumber: number; providerAccountId?: string; provider: string; model: string; capability: string; success: boolean; errorCode?: string; durationMs: number; tokens: TokenUsage | null; estimatedCost: number | null; pricingConfigured: boolean }`.
- `recordProviderAttempt(record: ProviderAttemptRecord): Promise<void>` writes one record for each actual provider invocation; retries in the same execution share `executionId` and increment `attemptNumber`.
- `getProviderAccountUsage(accountId: string, now?: Date)` returns `last5h` and `last7d` with distinct calls, attempts, prompt/completion/total tokens, nullable estimated cost, and pricing availability.

- [ ] **Step 1: Write failing tests** for per-attempt rows across API, `ExecutionGateway`, smart router, decision, and worker paths; correlation across fallback; nullable account for internal providers; cache exclusion; price snapshots; missing usage/prices; zero-priced configured models; historical logs without account attribution; and exact rolling-window boundaries.
- [ ] **Step 2: Run** `npm test -w apps/api -- provider-attempt-usage.test.ts` and confirm the new assertions fail.
- [ ] **Step 3: Add `ProviderAttempt` and `ModelConfig.pricingConfigured`.** Preserve `RequestLog` and `Usage` fields/behavior. Store nullable token/cost data when the provider did not return usage, and snapshot the model rates at attempt time.
- [ ] **Step 4: Implement attempt recording** in `ai.service`, `SmartRouterService`, `/v1/decide`, and worker execution. Record successful and failed actual calls; avoid duplicate writes when `ExecutionGateway` delegates to `SmartRouterService`; do not record local classifier fallbacks or cache hits; logging failure must not turn provider success into a failed inference.
- [ ] **Step 5: Implement account aggregation and `GET /admin/provider-accounts/:accountId/usage`.** Use parameterized SQL or equivalent distinct-call aggregation and return moving five-hour and seven-day windows.
- [ ] **Step 6: Update model-price writes** in the admin model endpoint so explicit zero prices differ from an unset price.
- [ ] **Step 7: Run** attempt/usage tests, API/worker typechecks, the full test suite, lint, and build; report external Ollama/Redis dependencies honestly.
- [ ] **Step 8: Commit only task-owned changes** after staged-diff review.
