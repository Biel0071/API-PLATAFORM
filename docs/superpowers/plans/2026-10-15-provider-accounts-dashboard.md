# Multi-account Provider Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let administrators add, edit, test, and disconnect multiple accounts per provider, and see account-specific tokens and estimated spend for the last five hours and seven days.

**Architecture:** Keep the canonical vanilla JavaScript dashboard. Replace the one-config-per-provider card state in `pages.providers()` with provider groups containing account cards; use the account CRUD, OAuth, test, and usage endpoints from the backend plans. Keep local provider logos and existing accessible dialog behavior.

**Tech Stack:** Vanilla JavaScript, CSS, Fastify JSON API, Playwright, Node.js 22+.

**Spec:** `docs/superpowers/specs/2026-10-15-provider-accounts-and-platform-visual-design.md`

**Dependencies:** Complete `2026-10-15-provider-account-storage-oauth.md` and `2026-10-15-provider-account-routing-usage.md` first.

## Global Constraints

- A página de provedores terá uma seção de conexões com cartões individuais por conta, ação de editar/desconectar/testar, indicação de saúde e métricas de cinco horas e sete dias.
- Uma ação de adicionar permitirá criar outra conta para um provedor já conectado.
- A seleção manual de conta será exposta nos caminhos de API apropriados; o comportamento padrão continuará automático.
- O estado “Online” só será mostrado após teste real bem-sucedido.
- A interface nunca receberá valores de segredo; respostas administrativas exporão somente indicadores como “credencial salva” ou “precisa reautorizar”.
- OAuth de Hugging Face e Google passará a armazenar tokens e estados de autorização por conta.
- Os valores serão rotulados como estimativas, nunca como faturas dos fornecedores.
- Quando não houver tarifa configurada, a interface mostrará os tokens e indicará custo indisponível em vez de inventar um valor.
- O layout deve permanecer funcional em 390 × 844, permitir navegação por teclado e manter foco visível.

## Review Focus

- Two accounts of one provider must render separately and edit the selected account only (`provider-connections.spec.ts`: two same-provider account cards and edit isolation).
- A failed load or failed test must not render an account as online (`provider-connections.spec.ts`: stale and failed health states).
- An edit with a blank secret must preserve the existing credential; switching to API key requires a new key when none is saved (`provider-connections.spec.ts`: credential preservation).
- OAuth polling must stop on close/navigation and update only the account that started it (`provider-connections.spec.ts`: account-scoped HF and Google flow cases).
- At 390 × 844, account cards and the add/edit dialog must remain reachable by keyboard without horizontal overflow (`provider-connections.spec.ts`: mobile viewport and focus tests).

---

### Task 1: Render provider groups and per-account connection cards

**Files:**

- Modify: `apps/dashboard/public/app.js` (`pages.providers` and provider card rendering)
- Modify: `apps/dashboard/public/app.css` (provider account cards and loading/error states)
- Modify: `qa/e2e/provider-connections.spec.ts`

**Interfaces:**

- Consume `GET /admin/providers`, `GET /admin/provider-accounts`, and the existing provider-options endpoint.
- Each account view uses `{ id, providerName, displayName, authMode, enabled, hasCredential, oauthNeedsReauth, health }`; it never contains secret values.
- Render provider grouping separately from the number of account cards; available providers remain addable even when no account exists.

- [ ] **Step 1: Add failing Playwright cases** for multiple accounts under one provider, provider grouping, empty/loading/error state, unavailable health, and local logos.
- [ ] **Step 2: Run** `.\qa\node_modules\.bin\playwright.cmd test qa/e2e/provider-connections.spec.ts --reporter=line` and confirm the new cases fail.
- [ ] **Step 3: Update the provider page data model and card renderer.** Key accounts by account id, show account label/auth mode/verified status, and place add/edit/test/disconnect actions on the correct card.
- [ ] **Step 4: Run** the provider-connection Playwright suite and inspect the rendered page at desktop and 390 × 844.
- [ ] **Step 5: Commit only task-owned hunks** after staged-diff review.

### Task 2: Add and edit an account through the accessible dialog

**Files:**

- Modify: `apps/dashboard/public/app.js` (provider dialog, OAuth handlers, account actions)
- Modify: `apps/dashboard/public/app.css` (account dialog fields and action states)
- Modify: `qa/e2e/provider-connections.spec.ts`

**Interfaces:**

- Create with `POST /admin/provider-accounts`; edit with `PATCH /admin/provider-accounts/:accountId`; disconnect with `DELETE /admin/provider-accounts/:accountId`; test with `POST /admin/provider-accounts/:accountId/test`.
- OAuth actions use account-scoped Hugging Face/Google endpoints from the backend plan.
- The dialog receives `providerName`, optional `accountId`, and an invoking DOM element; save returns the new/updated account view.

- [ ] **Step 1: Add failing tests** for create-two-accounts, edit only the selected account, preserving blank saved credentials, requiring a new key after switching auth mode, save errors, OAuth account isolation, provider-specific API-key/OAuth/local-server choices and portal links, disabled Gemini OAuth without HTTPS/client configuration, Escape, focus trap, focus return, and cancel during navigation.
- [ ] **Step 2: Run** the provider-connection Playwright suite and confirm the new cases fail.
- [ ] **Step 3: Implement add/edit actions.** Keep the secret input blank on edit, send account id only for updates, retain inline errors, disable duplicate submit, and refresh only the affected account group.
- [ ] **Step 4: Keep OAuth flow state per account.** Cancel polling on close/navigation, handle denied/expired/replayed flow responses, and never show “Online” after authorization alone.
- [ ] **Step 5: Run** the Playwright suite, including the 390 × 844 case.
- [ ] **Step 6: Commit only task-owned hunks** after staged-diff review.

### Task 3: Show tokens and estimated spend for each account

**Files:**

- Modify: `apps/dashboard/public/app.js` (account usage loading and rendering)
- Modify: `apps/dashboard/public/app.css` (usage summaries, unavailable-price state)
- Modify: `qa/e2e/provider-connections.spec.ts`

**Interfaces:**

- Consume `GET /admin/provider-accounts/:accountId/usage` returning `last5h` and `last7d`, each with distinct calls, attempts, prompt/completion/total tokens, nullable estimated cost, and pricing availability.
- Display labels explicitly as “Últimas 5 horas” and “Últimos 7 dias”; format null cost as “Tarifa não configurada”.

- [ ] **Step 1: Add failing tests** for both windows, zero cost with configured zero tariff, unavailable cost, loading/error response, and account-specific values when two accounts share a provider.
- [ ] **Step 2: Run** the focused provider Playwright suite and confirm the new metric assertions fail.
- [ ] **Step 3: Fetch and render account usage.** Keep the account card readable on mobile; do not count cache hits as account spend.
- [ ] **Step 4: Run** the provider-connection suite and the dashboard build.
- [ ] **Step 5: Commit only task-owned hunks** after staged-diff review.
