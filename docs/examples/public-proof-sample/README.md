# Public Proof Sample

This is Browserclickyard's single public-safe proof sample.

It is intentionally small, sanitized, and schema-faithful. Think of it like a
museum display model: it shows the shape of a governed run bundle without
opening the private runtime storeroom.

## What This Sample Proves

- Browserclickyard writes a governed run bundle with a `manifest.json` contract and a
  `reports/summary.json` report
- Public inspection can focus on safe structural fields without exposing broad
  runtime evidence
- The proof center can point to one concrete sample instead of scattering the
  public story across multiple mock narratives

## What This Sample Does Not Prove

- It is not a full runtime bundle
- It does not include logs, screenshots, traces, or failure bundles
- It does not replace private-only evidence retained under
  `.runtime-cache/artifacts/runs/<runId>/`

## Sanitized `reports/summary.json` Subset

```json
{
  "runId": "run-public-sample",
  "target": {
    "type": "web",
    "name": "web.local"
  },
  "profile": "pr",
  "gateStatus": "passed",
  "headline": "Governed run completed with canonical summary and evidence indexes.",
  "counts": {
    "consoleError": 0,
    "pageError": 0,
    "http5xx": 0
  }
}
```

## Sanitized `manifest.json` Subset

```json
{
  "schemaVersion": "1.1",
  "runId": "run-public-sample",
  "target": {
    "type": "web",
    "name": "web.local"
  },
  "profile": "pr",
  "execution": {
    "maxParallelTasks": 2,
    "criticalPath": ["capture", "report"]
  },
  "reports": {
    "report": "reports/summary.json"
  },
  "evidenceIndex": [
    {
      "id": "report.summary",
      "source": "report",
      "kind": "report",
      "path": "reports/summary.json"
    }
  ],
  "gateResults": {
    "status": "passed",
    "checks": [
      {
        "id": "console.error",
        "status": "passed",
        "reasonCode": "gate.console_error.passed.ok",
        "evidencePath": "reports/summary.json"
      }
    ]
  }
}
```

## How Proof Center Uses This

`docs/proof-center.md` links this page as the only public-safe sample surface.
If a future sample is needed, it should replace this page instead of creating a
second public proof narrative.
