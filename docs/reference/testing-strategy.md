# Testing Strategy

Browserclickyard uses a **testing pyramid with governed release gates**, not one giant
bucket of tests.

Think of it like building trust in layers:

- **unit tests** catch small logic mistakes fast
- **contract and integration tests** confirm ledgers, APIs, and projections stay aligned
- **component and frontend e2e tests** prove the product shell still behaves for operators
- **governed run and live gates** prove the runtime still tells the truth when real artifacts matter

## Pyramid

| Layer | Primary tools | What it protects | Fastest commands |
| --- | --- | --- | --- |
| Unit | `vitest`, `pytest` | local logic, formatting helpers, store behavior, API helpers | `bash scripts/lib/pnpm-safe.sh --dir apps/command-center run test -- --config vitest.config.ts`, `bash scripts/lib/python-exec.sh pytest -q -o addopts='' -n 0` |
| Contract | OpenAPI checks, API route tests, MCP doc contract | API semantics, generated-client scope, MCP registry/docs drift | `bash scripts/lib/pnpm-safe.sh mcp:doc:contract`, `bash scripts/lib/node-bin.sh tsx contracts/scripts/generate-client.ts --verify` |
| Integration | backend proof tests, workflow/API integration suites | proof surfaces, manual-gate flows, template/runs bridging | `uv run --extra dev pytest --no-cov services/api/tests/test_proof_api.py -q`, `bash scripts/lib/pnpm-safe.sh test:backend:integration-gate` |
| Component / shell | app `vitest`, Playwright CT | command center view semantics, a11y, shell guidance, locale-aware UX | `bash scripts/lib/pnpm-safe.sh --dir apps/command-center run test -- --config vitest.config.ts`, `pnpm test:ct` |
| E2E / governed | Playwright frontend e2e, `pnpm uiq run`, MCP smoke | operator-visible flows, governed artifacts, MCP adapter truth | `pnpm test:e2e:frontend:critical`, `bash scripts/lib/pnpm-safe.sh mcp:smoke` |

## Coverage Rules

- Repo-wide coverage gate stays **95% aggregate / 95% per threshold** when run
  through `pnpm test:coverage`.
- Frontend coverage lands under `.runtime-cache/coverage/apps/command-center/`.
- Apps-web harness coverage lands under `.runtime-cache/coverage/apps-web/`.
- Backend coverage lands under `.runtime-cache/coverage/backend-coverage.xml`.

## Fast Verification Order

Use this order when you want the fastest trustworthy signal:

1. `bash scripts/docs-gate.sh`
2. `bash scripts/lib/pnpm-safe.sh --dir apps/command-center run test -- --config vitest.config.ts`
3. `uv run --extra dev pytest --no-cov services/api/tests/test_proof_api.py -q`
4. `bash scripts/lib/pnpm-safe.sh mcp:doc:contract`
5. `bash scripts/lib/pnpm-safe.sh mcp:smoke`

## Truthful Test Vocabulary

- **unit** means one helper, one hook, or one store slice
- **contract** means API / MCP / generated-client agreement checks
- **integration** means multiple ledgers or services working together
- **component / shell** means the operator-facing React surface
- **governed / live** means the runtime is exercising real artifacts or real adapters

Do not collapse these into one generic word like “tests passed”.

That would be like saying “the building is safe” after checking only the light
switches. Browserclickyard wants you to say which layer passed.
