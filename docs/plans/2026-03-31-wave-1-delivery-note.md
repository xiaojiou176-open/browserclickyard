# Wave 1 Delivery Note

## Scope

This round focused on making the current strongest product line feel like a
real operator-facing surface instead of a collection of strong but separate
features.

The chosen Wave 1 slice was:

- first-use and lane clarity,
- clearer Task Center and Manual Gate product wording,
- clearer Review Board role framing,
- a first AI release brief reading layer,
- docs and API wording that support the same operator map.

## What Changed

### Docs And Front Door

- `README.md`
- `docs/get-started.md`
- `docs/why-prooflane.md`
- `docs/proof-center.md`
- `docs/reference/universal-api.md`

These files now share one operator-facing model:

- start in Quick Launch,
- track and unblock in Task Center,
- decide with governed evidence in Review Board,
- treat governed proof as the release-grade evidence path.

### Command Center Surface

- `apps/command-center/src/App.tsx`
- `apps/command-center/src/components/ConsoleHeader.tsx`
- `apps/command-center/src/views/QuickLaunchView.tsx`
- `apps/command-center/src/components/OnboardingTour.tsx`
- `apps/command-center/src/components/HelpPanel.tsx`
- `apps/command-center/src/views/TaskCenterView.tsx`
- `apps/command-center/src/features/manual-gates/ManualGateDesk.tsx`
- `apps/command-center/src/components/TaskListPanel.tsx`
- `apps/command-center/src/components/CommandGrid.tsx`
- `apps/command-center/src/views/ReviewBoardView.tsx`

What changed in plain language:

- the app now explains one recommended first path,
- Task Center no longer makes command runs and workflow runs sound like the
  same ledger,
- Manual Gate buttons and hints explain what the operator is about to do,
- Review Board now says when to come here and what needs to exist first,
- the first AI release brief now summarizes compare/AI-review signals into a
  reading layer instead of leaving them as raw parts.

### Tests Updated

- `ConsoleHeader.a11y.test.tsx`
- `QuickLaunchView.firstuse.test.tsx`
- `OnboardingTour.a11y.test.tsx`
- `HelpPanel.test.tsx`
- `TaskCenterView.a11y.test.tsx`
- `TaskCenterView.waiting-state.test.tsx`
- `TaskListPanel.a11y.test.tsx`
- `CommandGrid.test.tsx`
- `ReviewBoardView.test.tsx`

## Why These Changes Came First

These changes were chosen because they improve the current strongest product
line without forcing the repo to decide the larger Route A vs Route B fork.

They are safe because:

- both routes still need clear operator guidance,
- both routes still need honest truth-surface labeling,
- both routes still benefit from a more readable Review Board and Manual Gate
  surface.

## What This Round Did Not Try To Do

- It did not make Review Board the final dominant homepage surface.
- It did not rebrand the repo around the stress-lab route.
- It did not promote `load/perf/explore/chaos` to the homepage hero.
- It did not ship the full AI/MCP deepening backlog.

## Evidence

- targeted vitest: pass
- targeted eslint: pass
- docs-gate: only pre-existing root/workspace pollution failures remain
- blocker-only review: approve
