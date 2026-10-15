# Repository Guidelines

## Project Structure & Module Organization

- `apps/api/src/`: Fastify gateway, routes, services, and authentication; Prisma schema/migrations are in `apps/api/prisma/`.
- `apps/worker/src/`: BullMQ processors and background workers.
- `apps/dashboard/public/`: the only canonical vanilla JavaScript frontend, with HTML, CSS, and assets.
- `packages/shared/`: contracts and provider abstractions; `packages/sdk-{ts,js,python}/`: client SDKs.
- `apps/api/tests/`, `qa/contracts/`, and `qa/e2e/`: tests. Store docs in `docs/`, scripts in `scripts/`, logs in `logs/`, and infrastructure in `docker/`, `tools/`, or `deploy-vps/`.

## Build, Test, and Development Commands

Use Node.js 22+, PostgreSQL, and Redis.

- `npm install --workspaces --include-workspace-root`: install dependencies.
- `npm run dev:api` / `npm run dev:worker`: start local services.
- `npm run build`: build the dashboard, shared package, SDK, API, and worker.
- `npm test`: run Vitest backend and contract tests.
- `npm run lint`: run ESLint; `npx prettier --write <files>` formats changes.
- `npm run docker:up` / `npm run docker:down`: manage the Compose stack.
- `node qa/front-production-audit.cjs`: audit the dashboard against a running instance.

## Coding Style & Naming Conventions

Use strict TypeScript and the existing vanilla JavaScript style. Prettier uses two-space indentation, single quotes, semicolons, trailing commas, and 100-column lines. Use camelCase for functions/variables, PascalCase for types/classes, and descriptive names such as `health-check.service.ts`.

## Testing Guidelines

Vitest uses `*.test.ts` under `apps/api/tests/` and `qa/contracts/`; Playwright uses `*.spec.ts` under `qa/e2e/`. Add focused regression tests for changed behavior. Validate API contracts, persistence, errors, rapid navigation, reload, login/logout, and mobile at 390×844. Record failures in `TODO-BUGS.md`, isolate test data, and clean it up.

## Commit & Pull Request Guidelines

Use the Conventional Commit style seen in history, for example `fix(api): ...`, `fix(worker): ...`, `feat: ...`, or `docs(fenix): ...`. PRs should describe the problem and resulting behavior, reference audit IDs/issues, list validation commands and results, and include UI screenshots when relevant.

## Security & Stabilization

Keep credentials in environment files; never commit or print secrets. Before stabilization or destructive changes, record branch, commit, build, and runtime state, and preserve a rollback backup. Read `PROJECT_RULES.md`, `TODO-BUGS.md`, and `docs/AUDITORIA_FRONT_PRODUCAO_2026-09-08.md`. Fix existing defects first. Preserve the canonical frontend; do not create parallel systems or unnecessary redesigns. Never simulate provisioning or operational success with timers, fake status, or mocks. Every interactive element needs a real destination or function. Report offline dependencies honestly. Validate API, persistence, navigation, error states, rapid navigation, and mobile before claiming completion. Do not create a release commit or tag until validation passes.


# Global Agent Coding Principles & Methodology

## 1. Karpathy Core Principles
- **Think Before Coding**: Explicitly surface assumptions, constraints, and trade-offs. Never assume or proceed silently on ambiguity—clarify first.
- **Simplicity First**: Write the minimum code needed to solve the problem. Avoid speculative features, premature abstractions, or over-engineering. If 30 lines solve it clearly, do not write 150 lines.
- **Surgical Changes**: Touch only what is strictly necessary. Preserve existing patterns, style, and comments. Clean up only your own orphans.
- **Goal-Driven Execution**: Define verifiable success criteria upfront (reproduction tests, linters, commands) and verify before declaring completion.

## 2. Superpowers Engineering Workflow
- **Brainstorming Before Implementation**: For new features, clarify intent and user requirements with a clear spec before writing code.
- **Test-Driven Development (TDD)**: Write a failing reproduction test before fixing bugs or introducing new core behavior.
- **Systematic Debugging**: Find root causes methodically from logs, stack traces, and evidence. Never guess or apply random trial-and-error patches.
- **Subagent & Parallel Execution**: Break complex workflows into bite-sized, reviewable tasks.
- **Verification Before Completion**: Run automated tests, type checkers, and linters to prove the implementation works.

## 3. Code Standards & Architecture
- **Clarity & Maintainability**: Favor straightforward, self-documenting code over clever, convoluted abstractions.
- **Security & Hygiene**: Validate boundaries and sanitize inputs. Never commit or leak credentials, tokens, or private secrets.
