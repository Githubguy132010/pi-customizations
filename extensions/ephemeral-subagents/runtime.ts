import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Copy a tree while materializing symlinks and refusing links outside its approved root. */
async function copyApproved(source: string, destination: string, approvedRoot: string, seen = new Set<string>()): Promise<void> {
  const canonical = await realpath(source);
  if (!inside(approvedRoot, canonical)) throw new Error(`required runtime path escapes its approved source: ${source} -> ${canonical}`);
  const info = await lstat(canonical);
  if (info.isDirectory()) {
    if (seen.has(canonical)) throw new Error(`required runtime contains a symlink cycle at ${source}`);
    const nextSeen = new Set(seen).add(canonical);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(canonical)) await copyApproved(join(canonical, entry), join(destination, entry), approvedRoot, nextSeen);
  } else if (info.isFile()) {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, await readFile(canonical), { mode: info.mode & 0o777 });
  } else {
    throw new Error(`required runtime path is not a regular file or directory: ${source}`);
  }
}

async function packageAt(start: string, name: string): Promise<string> {
  let current = start;
  while (true) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    try { return await realpath(candidate); } catch { /* walk upward */ }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`required production dependency is not installed: ${name}`);
}

async function stagePackage(source: string, destination: string, topNodeModules: string, staged: Map<string, string>): Promise<void> {
  const canonical = await realpath(source);
  if (staged.get(destination) === canonical) return;
  if (staged.has(destination)) throw new Error(`conflicting production dependencies target ${destination}`);
  staged.set(destination, canonical);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(canonical)) {
    if (entry !== "node_modules") await copyApproved(join(canonical, entry), join(destination, entry), canonical);
  }
  const manifest = JSON.parse(await readFile(join(canonical, "package.json"), "utf8")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
  const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies };
  for (const name of Object.keys(dependencies).sort()) {
    let dependency: string;
    try { dependency = await packageAt(canonical, name); }
    catch (error) {
      if (manifest.optionalDependencies?.[name]) continue;
      throw error;
    }
    let target = join(topNodeModules, ...name.split("/"));
    const existing = staged.get(target);
    if (existing && existing !== dependency) target = join(destination, "node_modules", ...name.split("/"));
    await stagePackage(dependency, target, topNodeModules, staged);
  }
}

export async function stageDevelopmentRuntime(repoRoot: string, destination: string): Promise<string> {
  const canonicalRepo = await realpath(repoRoot);
  const manifest = JSON.parse(await readFile(join(canonicalRepo, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const temporary = `${destination}.tmp-${process.pid}`;
  await rm(temporary, { recursive: true, force: true });
  try {
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    for (const input of ["bin", "extensions", "package.json"]) {
      await copyApproved(join(canonicalRepo, input), join(temporary, input), canonicalRepo);
    }
    const staged = new Map<string, string>();
    for (const name of Object.keys(manifest.dependencies ?? {}).sort()) {
      const topNodeModules = join(temporary, "node_modules");
      await stagePackage(await packageAt(canonicalRepo, name), join(topNodeModules, ...name.split("/")), topNodeModules, staged);
    }
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
    return await realpath(destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw new Error(`secure subagent runtime staging failed: ${error instanceof Error ? error.message : String(error)}; install pi-coding-agent outside the repository checkout (for example with npm or mise) and launch that installation`);
  }
}
