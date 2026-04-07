import assert from "node:assert/strict";
import test from "node:test";
import {
  isFrontendAppReadySignal,
  isFrontendProbeReadyStatus,
  isRetryableFrontendBootError,
  isRetryableFrontendBootErrorMessage,
} from "./frontend-navigation.ts";

test("frontend retry classifier recognizes chromium and node connection failures", () => {
  assert.equal(
    isRetryableFrontendBootErrorMessage("net::ERR_CONNECTION_REFUSED at http://127.0.0.1:43173/"),
    true,
  );
  assert.equal(
    isRetryableFrontendBootError(
      new Error("request failed, cause: connect ECONNREFUSED 127.0.0.1"),
    ),
    true,
  );
});

test("frontend retry classifier recognizes firefox refused-connection error", () => {
  assert.equal(isRetryableFrontendBootErrorMessage("NS_ERROR_CONNECTION_REFUSED"), true);
});

test("frontend retry classifier recognizes reset/timeout/webkit variants", () => {
  assert.equal(
    isRetryableFrontendBootErrorMessage("page.goto: net::ERR_CONNECTION_RESET at http://127.0.0.1"),
    true,
  );
  assert.equal(isRetryableFrontendBootErrorMessage("Request failed with ERR_TIMED_OUT"), true);
  assert.equal(
    isRetryableFrontendBootErrorMessage(
      "Navigation failed because Could not connect to the server.",
    ),
    true,
  );
});

test("frontend retry classifier rejects non-retryable failures", () => {
  assert.equal(
    isRetryableFrontendBootErrorMessage("Timeout 30000ms exceeded while waiting for selector"),
    false,
  );
  assert.equal(isRetryableFrontendBootError({ message: "ERR_CONNECTION_REFUSED" }), false);
});

test("frontend readiness probe only accepts healthy http statuses", () => {
  assert.equal(isFrontendProbeReadyStatus(0), false);
  assert.equal(isFrontendProbeReadyStatus(199), false);
  assert.equal(isFrontendProbeReadyStatus(200), true);
  assert.equal(isFrontendProbeReadyStatus(302), true);
  assert.equal(isFrontendProbeReadyStatus(404), false);
  assert.equal(isFrontendProbeReadyStatus(503), false);
});

test("frontend app ready signal tolerates onboarding hiding the app from a11y tree", () => {
  assert.equal(
    isFrontendAppReadySignal({
      bootShellVisible: false,
      consoleRootVisible: true,
      titleVisible: false,
      navTabsVisible: true,
    }),
    true,
  );
  assert.equal(
    isFrontendAppReadySignal({
      bootShellVisible: true,
      consoleRootVisible: true,
      titleVisible: true,
      navTabsVisible: true,
    }),
    false,
  );
});
