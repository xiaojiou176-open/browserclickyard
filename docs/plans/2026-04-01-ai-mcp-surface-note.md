# AI And MCP Surface Note

## Core Rule

This repo now has three distinct layers for Wave 2:

- **truth**
- **AI reading/interpretation**
- **MCP access**

They must remain separate.

## Truth Layer

Truth still lives in the existing surfaces:

- workflow runs
- automation tasks
- governed run bundles
- proof campaigns
- template feasibility

## AI Layer

AI belongs in:

- release brief drafting
- grouped findings
- retrieval ranking
- next-step guidance

AI does **not** belong in:

- final approval
- hidden state mutation
- replacing governed proof
- replacing manual-gate ownership

## MCP Layer

MCP now has a clearer split:

- **Resources** for read-only context
- **Tools** for governed actions or summaries
- **Docs** for role-based reading paths

### Recommended mental model

- Operators use MCP to read summaries and inspect blocked work.
- Agents use MCP to gather context before proposing the next action.
- Reviewers use MCP to inspect proof and release summaries.

## Current Wave 2 Product Shape

### AI Release Brief

The AI release brief is now the top reading layer over:

- run compare
- AI review
- evidence snapshot
- next-step recommendation

### Manual Gate Copilot

The current copilot layer is intentionally modest:

- explain why the run is paused
- explain what to prepare
- explain what the resume action will do

It is a checklist assistant, not an auto-approver.

### Similar Failures Retrieval

The current retrieval design is intentionally narrow:

- it searches existing governed run evidence
- it ranks similar historical failure cases
- it returns why they matched
- it points back to the source run/report path

It is not a generic repo-wide chat/search interface.

### MCP Workspace

The current MCP workspace direction is:

- read AI review
- generate release brief
- inspect similar failures
- explain feasibility
- summarize manual gates

This keeps MCP useful without turning it into a parallel product shell.
