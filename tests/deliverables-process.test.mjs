import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import test from "node:test";
import { deliverableRequest } from "../mods/sessions-plus/deliverables-store.mjs";

const moduleUrl = new URL("../mods/sessions-plus/deliverables-store.mjs", import.meta.url).href;
const scope = { root: "/fixture/concurrent", on: null };
const value = { kind: "file", location: "reports/seed.md", title: "seed", note: "" };
const worker = String.raw`
import { readFileSync } from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
try {
  const { deliverableRequest } = await import(input.moduleUrl);
  const started = new Promise(resolve => process.once("message", resolve));
  process.send({ ready: true });
  await started;
  let result;
  if (input.kind === "writer") {
    for (let index = 0; index < input.count; index++) {
      const title = "writer-" + input.writer + "-" + index;
      await deliverableRequest(input.home, { action: "add", scope: input.scope, value: { kind: "file", title, location: "reports/" + title + ".md", note: "" } });
    }
    result = { writes: input.count };
  } else if (input.kind === "reader") {
    let revision = 0;
    for (let index = 0; index < input.count; index++) {
      const view = await deliverableRequest(input.home, { action: "view", scope: input.scope, filter: "all" });
      revision = Math.max(revision, view.revision);
      const found = await deliverableRequest(input.home, { action: "get", scope: input.scope, id: input.id, expected: input.expected });
      if (found.item.id !== input.id || found.item.revision !== input.expected) throw new Error("The stable seed changed during concurrent additions");
    }
    result = { reads: input.count * 2, revision };
  } else {
    try {
      const changed = await deliverableRequest(input.home, { action: "read", scope: input.scope, id: input.id, expected: input.expected, value: input.read });
      result = { saved: true, revision: changed.changed[0].revision };
    } catch (error) {
      if (error.code !== "conflict") throw error;
      result = { saved: false, code: error.code };
    }
  }
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.message, code: error.code, stack: error.stack, kind: input.kind, writer: input.writer }) + "\n");
  process.exitCode = 1;
} finally { if (process.connected) process.disconnect(); }
`;

async function fixture(t) {
  const home = await fs.mkdtemp("/private/tmp/deliverables-process-"), children = new Set(), completed = [];
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    await Promise.allSettled(completed);
    await fs.rm(home, { recursive: true, force: true });
  });
  const seed = await deliverableRequest(home, { action: "add", scope, value });
  const batch = async configurations => {
    const workers = configurations.map(configuration => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", worker], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
      children.add(child);
      let ready = false, readyResolve, readyReject, out = "", err = "", timedOut = false;
      const readiness = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      child.on("message", message => { if (message?.ready) { ready = true; readyResolve(); } });
      child.stdout.on("data", chunk => { out += chunk; });
      child.stderr.on("data", chunk => { err += chunk; });
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 15000);
      timer.unref();
      const completion = new Promise((resolve, reject) => {
        child.on("error", error => { readyReject(error); reject(error); });
        child.on("close", (code, signal) => {
          clearTimeout(timer); children.delete(child);
          if (!ready) readyReject(new Error("Worker exited before the start barrier: " + err + out));
          if (code !== 0) { reject(new Error("Worker failed (" + (timedOut ? "timeout" : signal || code) + "): " + err + out)); return; }
          try { resolve(JSON.parse(out)); } catch { reject(new Error("Invalid worker response: " + err + out)); }
        });
      });
      completed.push(completion);
      child.stdin.on("error", error => { if (error.code !== "EPIPE") readyReject(error); });
      child.stdin.end(JSON.stringify({ moduleUrl, home, scope, ...configuration }));
      return { child, readiness, completion };
    });
    const outcomes = Promise.allSettled(workers.map(row => row.completion));
    try {
      await Promise.all(workers.map(row => row.readiness));
      for (const row of workers) row.child.send({ start: true });
    } catch (error) {
      for (const row of workers) if (children.has(row.child)) row.child.kill("SIGKILL");
      await outcomes;
      throw error;
    }
    const result = await outcomes, failures = result.filter(row => row.status === "rejected");
    assert.equal(failures.length, 0, failures.map(row => row.reason?.stack || String(row.reason)).join("\n"));
    return result.map(row => row.value);
  };
  return { home, seed: seed.items[0], batch };
}

test("independent processes preserve every concurrent addition while view and get read atomic snapshots", async t => {
  const f = await fixture(t), writers = 8, each = 6;
  const result = await f.batch([
    ...Array.from({ length: writers }, (_, writer) => ({ kind: "writer", writer, count: each })),
    ...Array.from({ length: 2 }, () => ({ kind: "reader", count: 60, id: f.seed.id, expected: f.seed.revision })),
  ]);
  assert.equal(result.filter(row => row.writes === each).length, writers);
  assert(result.filter(row => row.reads).every(row => row.reads === 120 && row.revision > 1));
  const first = await deliverableRequest(f.home, { action: "view", scope, filter: "all" }), items = [...first.items];
  for (let page = 1; page < first.pages; page++) items.push(...(await deliverableRequest(f.home, { action: "view", scope, filter: "all", page })).items);
  const expected = ["seed", ...Array.from({ length: writers }, (_, writer) => Array.from({ length: each }, (_, index) => `writer-${writer}-${index}`)).flat()];
  assert.equal(first.revision, expected.length); assert.equal(first.total, expected.length);
  assert.equal(new Set(items.map(item => item.id)).size, expected.length);
  assert.deepEqual(items.map(item => item.title).sort(), expected.sort());
});

test("independent processes using one expected revision commit once and retain an explicit conflict", async t => {
  const f = await fixture(t), result = await f.batch([true, false].map(read => ({ kind: "cas", read, id: f.seed.id, expected: f.seed.revision })));
  assert.equal(result.filter(row => row.saved).length, 1);
  assert.equal(result.filter(row => !row.saved && row.code === "conflict").length, 1);
  const view = await deliverableRequest(f.home, { action: "view", scope, filter: "all" });
  assert.equal(view.revision, 2); assert.equal(view.total, 1); assert.equal(view.items[0].revision, 2);
  assert.equal((await deliverableRequest(f.home, { action: "get", scope, id: f.seed.id, expected: 2 })).item.id, f.seed.id);
});
