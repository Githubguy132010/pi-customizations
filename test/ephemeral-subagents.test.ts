import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { JobManager } from "../extensions/ephemeral-subagents/manager.ts";
import { AuthenticatedProtocol } from "../extensions/ephemeral-subagents/protocol.ts";
import { SessionStore } from "../extensions/ephemeral-subagents/session.ts";

const exec = promisify(execFile);

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "subagent-repo-"));
  await exec("git", ["init", root]);
  await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", root, "config", "user.name", "Test"]);
  await writeFile(join(root, "a.txt"), "original\n");
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "commit", "-m", "initial"]);
  return root;
}

test("authenticated protocol rejects malformed, duplicate, and out-of-order frames", () => {
  const protocol = new AuthenticatedProtocol("job", "secret");
  const first = protocol.encode("status", 1).trim();
  assert.equal(protocol.decode(first)?.type, "status");
  assert.equal(protocol.decode(first), undefined);
  assert.throws(() => protocol.decode("nope"), /malformed/);
  assert.equal(protocol.decode(protocol.encode("late", 3).trim())?.seq, 3);
  assert.throws(() => protocol.decode(protocol.encode("old", 2).trim()), /out-of-order/);
  const tampered = JSON.parse(new AuthenticatedProtocol("job", "bad").encode("x", 4));
  assert.throws(() => protocol.decode(JSON.stringify(tampered)), /authentication/);
});

test("session creates a disposable worktree and removal is idempotent", async () => {
  const repo = await repository();
  const base = await mkdtemp(join(tmpdir(), "subagent-sessions-"));
  const store = new SessionStore(base);
  const session = await store.create(repo, "job");
  assert.equal(await readFile(join(session.worktree, "a.txt"), "utf8"), "original\n");
  await writeFile(join(session.worktree, "a.txt"), "changed\n");
  assert.equal(await readFile(join(repo, "a.txt"), "utf8"), "original\n");
  await store.remove(session);
  await store.remove(session);
  await rm(repo, { recursive: true, force: true });
  await rm(base, { recursive: true, force: true });
});

class RetryStore extends SessionStore {
  attempts = 0;
  override async remove(session: any) {
    this.attempts++;
    if (this.attempts === 1) throw new Error("busy");
    return super.remove(session);
  }
}

test("manager runs concurrent host jobs, captures results, and retries cleanup", async () => {
  const repo = await repository();
  const dir = await mkdtemp(join(tmpdir(), "subagent-fake-"));
  const script = join(dir, "fake.mjs");
  await writeFile(script, `process.stdin.on('data',d=>{for(const l of d.toString().trim().split('\\n')){const c=JSON.parse(l);if(c.type==='prompt'){console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'done'}}));console.log(JSON.stringify({type:'agent_settled'}));}}});`);
  const store = new RetryStore(join(dir, "sessions"));
  const manager = new JobManager({ repoRoot: repo, cwd: repo, piScript: script, limits: { concurrency: 2, runtimeMs: 5000 }, sessionStore: store });
  const group = manager.launch([{ task: "one" }, { task: "two" }]);
  const results = await manager.waitGroup(group.groupId);
  assert.deepEqual(results.map(result => result.state), ["completed", "completed"]);
  assert.deepEqual(results.map(result => result.output), ["done", "done"]);
  assert.ok(results.every(result => !result.sandboxed && result.sandbox === "none (host process)"));
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(results.some(result => result.cleanupPending), false);
  assert.ok(store.attempts >= 3);
  await manager.shutdown();
  await rm(repo, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});

test("queued cancellation is terminal and never starts", async () => {
  const repo = await repository();
  const dir = await mkdtemp(join(tmpdir(), "subagent-cancel-"));
  const script = join(dir, "linger.mjs");
  await writeFile(script, `process.stdin.resume();setTimeout(()=>{},10000);`);
  const manager = new JobManager({ repoRoot: repo, cwd: repo, piScript: script, limits: { concurrency: 1, runtimeMs: 5000 }, sessionStore: new SessionStore(join(dir, "sessions")) });
  const group = manager.launch([{ task: "running" }, { task: "queued" }]);
  manager.cancel(group.jobIds[1]);
  assert.equal((await manager.wait(group.jobIds[1])).state, "cancelled");
  manager.cancel(group.jobIds[0]);
  assert.equal((await manager.wait(group.jobIds[0])).state, "cancelled");
  await manager.shutdown();
  await rm(repo, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});
