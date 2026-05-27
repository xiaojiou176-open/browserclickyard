import assert from "node:assert/strict";
import test from "node:test";
import { runProfile } from "./run.js";

test("runProfile rejects malicious runId", async () => {
  await assert.rejects(
    runProfile("pr", "web.local", "../../escape", { autostartTarget: false }),
    /Invalid runId/,
  );
});
