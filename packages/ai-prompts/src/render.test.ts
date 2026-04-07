import assert from "node:assert/strict";
import test from "node:test";
import { renderTemplate } from "./render.js";

test("renderTemplate throws when variables are missing", () => {
  assert.throws(
    () => renderTemplate("run={{runId}} profile={{profile}}", { runId: "run-001" }),
    /Missing template variables: profile/,
  );
});
