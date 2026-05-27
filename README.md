<p align="center">
  <img src="https://em-content.zobj.net/source/apple/391/desktop-computer_1f5a5-fe0f.png" width="120" alt="desktop computer" />
</p>

<h1 align="center">browserclickyard</h1>

<p align="center">
  <strong>your AI clicks, your browser obeys</strong>
</p>

<p align="center">
  <a href="https://github.com/xiaojiou176-open/browserclickyard/stargazers"><img src="https://img.shields.io/github/stars/xiaojiou176-open/browserclickyard?style=flat&color=yellow" alt="Stars"></a>
  <a href="https://github.com/xiaojiou176-open/browserclickyard/commits/main"><img src="https://img.shields.io/github/last-commit/xiaojiou176-open/browserclickyard?style=flat" alt="Last Commit"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/xiaojiou176-open/browserclickyard?style=flat" alt="License"></a>
</p>

<p align="center">
  <a href="#what-you-get">What You Get</a> •
  <a href="#install">Install</a> •
  <a href="#how-it-work">How It Work</a> •
  <a href="#ecosystem">Ecosystem</a>
</p>

---

browserclickyard is the cockpit for AI-driven browser automation. Hand a goal to your agent, watch the panel, take over with one keypress when needed.

```
┌──────────────────────────────────────┐
│  LOCAL-FIRST          ████████ 100%  │
│  SOURCE-TRACEABLE     ████████ 100%  │
│  TYPING REQUIRED      ░░░░░░░░   0%  │
│  VIBES                ████████ ZERO  │
│                                FILLER│
└──────────────────────────────────────┘
```

> Command center for browser automation. CDP under the hood, agent on top.

## What You Get

| Surface | What |
|---|---|
| `command center` | Live console for goals, runs, params, and results. |
| `mcp services` | Expose browser automation to any MCP-compatible agent. |
| `contracts` | Versioned goal/run/result schemas. Replays are deterministic. |
| `packages` | Shared CDP primitives, locator stability helpers, retry policies. |
| `public skills` | Drop into Claude/Codex/OpenClaw. Goal in, browser obeys. |

> [!IMPORTANT]
> Local-first by default. No silent telemetry. No cloud round-trip. Your data stays on your machine until you explicitly ship it somewhere.

## Install

```bash
git clone https://github.com/xiaojiou176-open/browserclickyard.git
cd browserclickyard
# follow the per-stack quickstart in INSTALL.md or docs/
```

Three commands. No `curl | sh`. No login. Read what you run.

Install break? Open your favorite agent and say *"Read AGENTS.md and bootstrap browserclickyard for me."* Agent fix own brain. Long version: [`docs/`](./docs/).

## How It Work

The repo is seven layers — exactly the seven commits in `git log`. New work goes in as small named PRs. No 50-file mystery commits.

| Layer | What |
|---|---|
| `chore: scaffold` | License, governance, hygiene gates, CI scaffolding. |
| `feat(core)` | The primary engine. The reason browserclickyard exists. |
| `feat(modules)` | Packages, adapters, services, plugins. The second floor. |
| `feat(contracts)` | Schemas, configs, public boundaries. Other code talks here. |
| `test:` | Receipts. Everything in this layer must run. |
| `feat(ops)` | Scripts, infra, CI helpers, build glue. |
| `docs:` | Public docs surface. The pretty face. |

`git log` reads like a building floor plan. Look once, know the whole shape.

## Ecosystem

browserclickyard lives in the **yard family**: seven yards. one philosophy: structured input, structured output, structured proof.

| Repo | What |
|---|---|
| [**switchyard**](https://github.com/xiaojiou176-open/switchyard) | model & agent runtime switch board |
| [**browserclickyard**](https://github.com/xiaojiou176-open/browserclickyard) *(you here)* | your AI clicks, your browser obeys |
| [**noteyard**](https://github.com/xiaojiou176-open/noteyard) | your Apple Notes never really die |
| [**dealyard**](https://github.com/xiaojiou176-open/dealyard) | let prices fight, you sit and watch |
| [**docyard**](https://github.com/xiaojiou176-open/docyard) | docs site in, markdown out, no scraping by hand |
| [**fileyard**](https://github.com/xiaojiou176-open/fileyard) | messy folders in, organized library out |
| [**proofyard**](https://github.com/xiaojiou176-open/proofyard) | every claim ships with its receipt |

Cross-family taste:
[**BeamMe**](https://github.com/xiaojiou176-open/BeamMe) ·
[**BrewMe**](https://github.com/xiaojiou176-open/BrewMe) ·
[**OpenVibeCoding**](https://github.com/xiaojiou176-open/OpenVibeCoding) ·
[**proofyard**](https://github.com/xiaojiou176-open/proofyard).

## Star This Repo

If browserclickyard saves you a click, an hour, or a headache — star costs zero. Fair trade. ⭐

[![Star History Chart](https://api.star-history.com/svg?repos=xiaojiou176-open/browserclickyard&type=Date)](https://star-history.com/#xiaojiou176-open/browserclickyard&Date)

## Also by Yifeng[Terry] Yu

- **[switchyard](https://github.com/xiaojiou176-open/switchyard)** — model & agent runtime switch board
- **[noteyard](https://github.com/xiaojiou176-open/noteyard)** — your Apple Notes never really die
- **[BeamMe](https://github.com/xiaojiou176-open/BeamMe)** — beam your agent config to any planet
- **[BrewMe](https://github.com/xiaojiou176-open/BrewMe)** — wake up, news already brewed
- **[OpenVibeCoding](https://github.com/xiaojiou176-open/OpenVibeCoding)** — AI codes overnight, you ship in the morning

## License

MIT — small print, big freedom.
