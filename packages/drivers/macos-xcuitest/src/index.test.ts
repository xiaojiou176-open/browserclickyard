import assert from "node:assert/strict";
import test from "node:test";
import { buildBundleQuery, checkSwiftBundle } from "./index.js";

test("buildBundleQuery escapes dangerous characters", () => {
  const query = buildBundleQuery('com.example.app"; touch /tmp/pwned; echo "\\x');
  assert.match(query, /^kMDItemCFBundleIdentifier == "/);
  assert.ok(query.includes('\\"; touch /tmp/pwned; echo \\"'));
});

test("checkSwiftBundle passes query as argv without shell", () => {
  const calls: Array<{ cmd: string; args: unknown[]; options: unknown }> = [];
  const runner = {
    spawnSync: (cmd: string, args?: readonly string[], options?: unknown) => {
      calls.push({ cmd, args: [...(args ?? [])], options });
      if (cmd === "which") {
        return { status: 0 } as { status: number };
      }
      if (cmd === "mdfind") {
        return { status: 0, stdout: "/Applications/Test.app\n" } as {
          status: number;
          stdout: string;
        };
      }
      return { status: 1, stdout: "" } as { status: number; stdout: string };
    },
  };

  const result = checkSwiftBundle('com.example.app"; touch /tmp/pwned; echo "', runner);
  assert.equal(result.status, "passed");

  const mdfindCall = calls.find((call) => call.cmd === "mdfind");
  assert.ok(mdfindCall);
  const argv = mdfindCall.args as string[];
  assert.equal(argv.length, 1);
  assert.match(argv[0], /^kMDItemCFBundleIdentifier == "/);
  assert.ok(!String(argv[0]).includes(" | "));
  assert.ok(!String(argv[0]).includes(" && "));

  const options = mdfindCall.options as { shell?: boolean };
  assert.equal(options.shell, undefined);
  assert.equal((options as { timeout?: number }).timeout, 5000);
  assert.equal((options as { killSignal?: string }).killSignal, "SIGKILL");
});

test("checkSwiftBundle returns timeout reason when mdfind probe times out", () => {
  const runner = {
    spawnSync: (cmd: string) => {
      if (cmd === "which") {
        return { status: 0 } as { status: number };
      }
      if (cmd === "mdfind") {
        const error = Object.assign(new Error("spawnSync mdfind ETIMEDOUT"), { code: "ETIMEDOUT" });
        return { status: null, stdout: "", error } as {
          status: null;
          stdout: string;
          error: Error;
        };
      }
      return { status: 1, stdout: "" } as { status: number; stdout: string };
    },
  };

  const result = checkSwiftBundle("com.example.app", runner);
  assert.equal(result.status, "blocked");
  assert.equal(result.reasonCode, "desktop.swift.bundle.lookup_timeout");
  assert.match(result.detail, /timed out/i);
});
