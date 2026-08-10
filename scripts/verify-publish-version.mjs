import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const match = packageManifest.version.match(/^0\.0\.0-git\.([0-9a-f]{12,40})$/);

if (!match) {
  console.error(
    `Refusing to publish version ${packageManifest.version}; expected 0.0.0-git.<12-to-40-character-commit-hash>.`,
  );
  process.exit(1);
}

const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!commit.startsWith(match[1])) {
  console.error(
    `Refusing to publish build ${match[1]}; the current commit is ${commit}.`,
  );
  process.exit(1);
}

console.log(`Verified publish version ${packageManifest.version} for commit ${commit}.`);
