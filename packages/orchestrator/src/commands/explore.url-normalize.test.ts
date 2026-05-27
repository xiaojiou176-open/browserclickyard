import assert from "node:assert/strict";
import test from "node:test";
import { isPathInScope, normalizeExploreBase, normalizeNavigableUrl } from "./explore.js";

test("normalizeNavigableUrl removes trailing slashes and keeps query", () => {
  assert.equal(normalizeNavigableUrl("http://127.0.0.1:17373//"), "http://127.0.0.1:17373/");
  assert.equal(
    normalizeNavigableUrl("http://127.0.0.1:17373/app///?q=1"),
    "http://127.0.0.1:17373/app?q=1",
  );
});

test("normalizeExploreBase captures base scope for root and nested paths", () => {
  const root = normalizeExploreBase("http://127.0.0.1:17373/");
  assert.equal(root.normalizedBaseUrl, "http://127.0.0.1:17373/");
  assert.equal(root.origin, "http://127.0.0.1:17373");
  assert.equal(root.pathPrefix, "");

  const nested = normalizeExploreBase("http://127.0.0.1:17373/app/");
  assert.equal(nested.normalizedBaseUrl, "http://127.0.0.1:17373/app");
  assert.equal(nested.pathPrefix, "/app");
});

test("isPathInScope enforces nested path scope", () => {
  assert.equal(isPathInScope("/foo", ""), true);
  assert.equal(isPathInScope("/app", "/app"), true);
  assert.equal(isPathInScope("/app/page", "/app"), true);
  assert.equal(isPathInScope("/other/page", "/app"), false);
});
