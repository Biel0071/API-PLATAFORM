# Platform-Wide Visual Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the provider page’s visual quality and the supplied API Platform identity consistently to every dashboard route, with local branding assets and an accessible orbital motion treatment.

**Architecture:** Preserve the canonical vanilla JavaScript single-page dashboard and each route’s existing information hierarchy and actions. Establish the shared visual system in the app shell and stylesheet, then update route-specific markup only where shared components do not provide the intended hierarchy. Keep logos local and treat the supplied image as a visual reference.

**Tech Stack:** Vanilla JavaScript, CSS, SVG, Playwright, Node.js 22+.

**Spec:** `docs/superpowers/specs/2026-10-15-provider-accounts-and-platform-visual-design.md`

**Dependency:** Complete `2026-10-15-provider-accounts-dashboard.md` first. Do not implement concurrently with the provider dashboard plan because both modify `app.js` and `app.css`.

## Global Constraints

- As demais páginas usarão o mesmo sistema visual de cores, superfícies, tipografia, espaçamento, botões, formulários e estados.
- A migração será por grupos de páginas, mas incluirá todas as rotas do site, mantendo a hierarquia e a finalidade de cada tela.
- A marca terá SVG local próprio, derivado da referência enviada, sem depender de imagens externas.
- O anel orbital poderá girar no cabeçalho e em outros pontos de marca adequados; `prefers-reduced-motion` desativará movimento contínuo.
- Logos de provedores serão locais e terão texto acessível.
- O layout deve permanecer funcional em 390 × 844, permitir navegação por teclado e manter foco visível.
- Cartões e gráficos não serão usados onde atrapalharem a leitura ou as ações específicas da página.

## Review Focus

- The local logo and provider marks load without network requests and expose accessible names (`platform-branding.spec.ts`: asset request and accessible-name assertions).
- The orbital ring moves under normal settings and becomes static when reduced motion is enabled (`platform-branding.spec.ts`: media preference and computed-animation assertions).
- All routes still render their title, primary content, and original working actions (`platform-branding.spec.ts`: authenticated route smoke for every route and alias).
- Shared forms, status messages, navigation, and focus styles remain readable and operable by keyboard (`platform-branding.spec.ts`: tab order, visible focus, contrast/state selectors).
- Every route fits 390 × 844 without horizontal page overflow and keeps its primary action reachable (`platform-branding.spec.ts`: viewport sweep across all routes).

---

### Task 1: Add the local brand mark and shared shell treatment

**Files:**

- Create: `apps/dashboard/public/assets/brand/api-platform.svg`
- Modify: `apps/dashboard/public/index.html` (login and application shell brand)
- Modify: `apps/dashboard/public/app.css` (brand mark and orbit animation)
- Test: `qa/e2e/platform-branding.spec.ts`

**Interfaces:**

- The shared mark is a self-contained SVG served from `/assets/brand/api-platform.svg` and contains no external resources.
- Shell and login use the same mark with meaningful alternative text; decorative orbital elements are hidden from assistive technology.
- The ring animation is CSS-only and disabled by `@media (prefers-reduced-motion: reduce)`.

- [ ] **Step 1: Add failing Playwright checks** for local asset loading, shell/login use, accessible naming, reduced-motion behavior, and no remote image requests.
- [ ] **Step 2: Run** `.\qa\node_modules\.bin\playwright.cmd test qa/e2e/platform-branding.spec.ts --reporter=line` and confirm the assertions fail.
- [ ] **Step 3: Create the SVG** from the provided visual reference using a compact blue orbital mark with legible proportions at favicon, sidebar, and login sizes; replace the shell’s text/emoji brand treatment where appropriate.
- [ ] **Step 4: Add the ring animation** with a static reduced-motion fallback and retain a visible focus outline around any interactive brand link.
- [ ] **Step 5: Run** the focused Playwright checks and inspect login plus authenticated shell at desktop and 390 × 844.

### Task 2: Apply shared visual tokens and components to every route

**Files:**

- Modify: `apps/dashboard/public/app.css` (shared tokens, shell, navigation, surfaces, controls, responsive rules)
- Modify: `apps/dashboard/public/app.js` (shared class hooks and route markup only where needed)
- Test: `qa/e2e/platform-branding.spec.ts`

**Interfaces:**

- Keep existing `pages` functions, router aliases, API calls, and navigation URLs stable.
- Route groups covered: overview, projects, and project details; providers, models, and playground; image/video generation, providers, queue, history, models, and analytics; workers, queues, usage, cache, and logs; users, keys, settings, security, backup, tenants, and admin routes; ComfyUI and Ollama setup, workflows, prompts, Lovable, integrations, SDK/base URL, and Fênix/mission/health/runtime/metrics/ICP pages.
- Shared styles use the current CSS custom properties and semantic classes so pages retain their current actions and data bindings.

- [ ] **Step 1: Add table-driven route-smoke assertions** for every key in `pages` and every router alias, using authenticated local fixtures and mocked admin responses; check route title, nonempty primary content, original primary action, and absence of an uncaught render error.
- [ ] **Step 2: Run** the route smoke suite and capture baseline overflow and missing-content failures at desktop and mobile sizes.
- [ ] **Step 3: Normalize the shared shell and common components.** Apply the provider page’s surface, spacing, typography, button, form, badge, table, and empty/loading/error patterns to all listed route groups while keeping page-specific information structure.
- [ ] **Step 4: Replace only route markup that prevents shared styles from working.** Keep IDs, data attributes, event listeners, permission gates, and API contracts stable; add local provider marks where provider identity is presented.
- [ ] **Step 5: Run** the full route smoke suite and inspect representative overview, generation, operations, and administration pages at desktop and 390 × 844.

### Task 3: Verify accessibility, responsiveness, and interaction regressions

**Files:**

- Modify: `qa/e2e/platform-branding.spec.ts`
- Modify: `apps/dashboard/public/app.css` (only for verified accessibility or responsive defects)
- Modify: `apps/dashboard/public/app.js` (only for verified interaction regressions)

**Interfaces:**

- The shell and all routes keep their existing keyboard navigation and actions; every interactive element remains a native link, button, or form control.
- Mobile layout uses the existing navigation drawer behavior and does not hide primary content or actions.

- [ ] **Step 1: Add failing checks** for keyboard reachability, visible focus, mobile drawer navigation, reduced motion, horizontal overflow, and primary action visibility across all routes.
- [ ] **Step 2: Run** `.\qa\node_modules\.bin\playwright.cmd test qa/e2e/platform-branding.spec.ts --reporter=line` and inspect failures by route group.
- [ ] **Step 3: Correct only evidenced defects** in shared CSS or route markup, preserving labels, accessible names, focus order, and route behavior.
- [ ] **Step 4: Run** the new branding suite, existing `qa/e2e/provider-connections.spec.ts`, dashboard build, `npm run lint`, and `npm run build`.
- [ ] **Step 5: Commit only task-owned hunks** after staged-diff review; leave unrelated existing changes untouched.
