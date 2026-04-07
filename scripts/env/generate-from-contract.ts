import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadContract, renderConfigurationDoc, renderEnvExample } from "./lib.ts";

function main(): void {
  const root = resolve(".");
  const contract = loadContract(root);

  const envExamplePath = resolve(root, ".env.example");
  const configDocPath = resolve(root, "docs/reference/configuration.md");

  writeFileSync(envExamplePath, renderEnvExample(contract), "utf8");
  writeFileSync(configDocPath, renderConfigurationDoc(contract), "utf8");

  process.stdout.write(`generated: ${envExamplePath}\n`);
  process.stdout.write(`generated: ${configDocPath}\n`);
}

main();
