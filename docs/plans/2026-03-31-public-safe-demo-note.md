# Public-safe Demo Note

## What ships in Prompt 5

The public-safe demo surface for Prooflane is now:

- [Public Stress Lab Guided Demo](../examples/public-stress-lab-guided-demo.md)
- [Public Proof Sample](../examples/public-proof-sample/README.md)

## Why this is the right demo shape

Prooflane cannot safely promise a live hosted demo without risking secrets, private artifacts, or misleading claims about current runtime access.

So the safe shape is:

- a **guided demo** for product understanding
- a **single proof sample** for governed-evidence understanding

That gives outside readers something real to inspect without crossing the public/private artifact boundary.

## Safety boundary

The demo surface does **not** include:

- live secrets
- private runtime bundles
- failure bundles
- broad hosted sandbox access

## Next-step upgrade path

If a future hosted or read-only demo is added, it should extend this guided demo rather than replacing the current public-safe proof rules.
