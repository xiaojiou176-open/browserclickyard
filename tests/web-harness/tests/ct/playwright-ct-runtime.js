import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { expect, test as baseTest } from "@playwright/test";

const require = createRequire(import.meta.url);
const ctCoreDir = dirname(require.resolve("@playwright/experimental-ct-core"));
const { fixtures } = require(resolve(ctCoreDir, "lib/mount.js"));

const test = baseTest.extend(fixtures);

export { expect, test };
