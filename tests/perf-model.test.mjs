import assert from "node:assert/strict";
import test from "node:test";
import { parsePs, usageSnapshot, formatCpu, formatMemory, badgeMemory, pressure, pushSample } from "../mods/sessions-plus/perf-model.js";

const PS = [
  "    1     0   0.0  12000 /sbin/launchd",
  " 1036     1  10.0 331520 /Applications/Herdr.app/Contents/MacOS/Herdr",
  " 1202  1036   0.0   4976 /Users/me/.local/bin/herdr-core",
  " 1782  1202   0.4  17152 /Users/me/.local/bin/herdr-core",
  " 1802  1782   0.0  11664 /Users/me/.local/bin/herdr-core",
  " 2000  1782   0.1   6000 /bin/zsh",
  " 2001  2000  35.5 400000 /Users/me/.local/bin/claude",
  " 2002  2001   2.0  80000 node",
  " 2100  1782   0.0   5000 -zsh",
  " 3000     1  99.0 900000 /Applications/Other.app/Contents/MacOS/Other",
  "garbage line",
].join("\n");

test("ps rows parse with resident memory in bytes and the program's base name", () => {
  const rows = parsePs(PS);
  assert.equal(rows.length, 10);
  assert.deepEqual(rows[1], { pid: 1036, ppid: 1, cpu: 10, rss: 331520 * 1024, name: "Herdr" });
  assert.equal(rows[8].name, "-zsh");
});

test("Herdr counts the app and herdr-core; each terminal counts its whole process tree", () => {
  const s = usageSnapshot(parsePs(PS));
  assert.deepEqual(s.app, { count: 1, cpu: 10, memory: 331520 * 1024 });
  assert.equal(s.core.count, 3); assert.equal(Math.round(s.core.cpu * 10), 4);
  assert.equal(s.terminals.length, 2);
  const [agent, shell] = s.terminals;
  assert.equal(agent.label, "claude"); assert.equal(agent.shell, "zsh"); assert.equal(agent.processes, 3);
  assert.equal(agent.memory, (6000 + 400000 + 80000) * 1024);
  assert.equal(shell.label, "-zsh"); assert.equal(shell.processes, 1);
  // Unrelated programs stay out of every total.
  assert.equal(s.memory, s.herdr.memory + s.terminalMemory);
  assert.ok(s.cpu < 99);
  assert.equal(usageSnapshot(parsePs("  1 0 0.0 100 /sbin/launchd")), null);
});

test("formats follow Orca: one-decimal CPU, KB / MB / GB memory, and a compact badge", () => {
  assert.equal(formatCpu(8.06), "8.1%"); assert.equal(formatCpu(NaN), "—");
  assert.equal(formatMemory(512 * 1024), "512 KB");
  assert.equal(formatMemory(331520 * 1024), "323.8 MB");
  assert.equal(formatMemory(1.5 * 1024 ** 3), "1.50 GB");
  assert.equal(badgeMemory(331520 * 1024), "324 MB"); assert.equal(badgeMemory(2 * 1024 ** 3), "2.0 GB");
});

test("pressure flags heavy Herdr use only, and the sample history keeps the newest values", () => {
  const s = usageSnapshot(parsePs(PS));
  assert.equal(pressure(s), null); assert.equal(pressure(null), null);
  assert.equal(pressure({ ...s, herdr: { ...s.herdr, cpu: 90 } }), "high");
  assert.equal(pressure({ ...s, herdr: { ...s.herdr, memory: 2 * 1024 ** 3 } }), "high");
  assert.deepEqual(pushSample([1, 2, 3], 4, 3), [2, 3, 4]);
  assert.deepEqual(pushSample(null, NaN), []);
});
