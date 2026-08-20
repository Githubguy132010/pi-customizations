#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "@earendil-works/pi-coding-agent";

import { areExperimentalFeaturesEnabled } from "../extensions/shared/experimental.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const bundledExtensions = [
  "extensions/bash-only/index.ts",
  "extensions/session-workdir/index.ts",
  "extensions/slash-command-visibility/index.ts",
  "extensions/yeet/index.ts",
  "extensions/settle/index.ts",
  ...(areExperimentalFeaturesEnabled()
    ? ["extensions/ephemeral-agents/index.ts"]
    : []),
];
const extensionArgs = bundledExtensions.flatMap((extension) => [
  "--extension",
  join(packageRoot, extension),
]);
const args = process.argv.slice(2);

if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
  const build = packageManifest.version.match(/^0\.0\.0-git\.([0-9a-f]+)$/)?.[1] ?? "development";
  const piVersion = packageManifest.dependencies["@earendil-works/pi-coding-agent"];
  console.log(`${packageManifest.name} build ${build} (Pi ${piVersion})`);
  process.exit(0);
}

process.title = "pi-coding-agent";
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";

await main([...args, ...extensionArgs]);
