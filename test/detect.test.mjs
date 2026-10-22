import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, readPathsIn, wholeFileDumps, isWholeRead, NET_SHELL, INLINE_HTTP } from "../src/detect.js";

// sizes keyed by path
const sizes = {
  "small.md": 1024,
  "big.md": 95 * 1024,
  "C:/tmp/big.md": 95 * 1024,
};
const sizeOf = (p) => (p in sizes ? sizes[p] : -1);
const opts = { sizeOf, bigFileBytes: 24 * 1024 };

test("readPathsIn finds read calls in Code Mode snippets", () => {
  assert.deepEqual(readPathsIn('tools.read({ path: "a.md" })'), ["a.md"]);
  assert.deepEqual(readPathsIn('tools.read("b.md")'), ["b.md"]);
  assert.deepEqual(readPathsIn('read({path:"c.md"})'), ["c.md"]);
  assert.deepEqual(readPathsIn('read("d.md")'), ["d.md"]);
  assert.deepEqual(readPathsIn("no reads here"), []);
});

test("readPathsIn does not match unrelated words ending in read", () => {
  assert.deepEqual(readPathsIn("thread = 1"), []);
  assert.deepEqual(readPathsIn("already()"), []);
});

test("wholeFileDumps finds file dumps but not capped ones", () => {
  assert.deepEqual(wholeFileDumps("cat big.md"), ["big.md"]);
  assert.deepEqual(wholeFileDumps("Get-Content big.md"), ["big.md"]);
  assert.deepEqual(wholeFileDumps("type big.md"), ["big.md"]);
  assert.deepEqual(wholeFileDumps("cat -n 50 big.md"), []);
  assert.deepEqual(wholeFileDumps("Get-Content big.md | Select-Object -First 20"), []);
  assert.deepEqual(wholeFileDumps("cat 50"), []);
});

test("wholeFileDumps reports the uncapped side of a mixed command", () => {
  assert.deepEqual(wholeFileDumps("cat small.md | cat big.md"), ["small.md", "big.md"]);
});

test("isWholeRead is true only without limit or offset", () => {
  assert.equal(isWholeRead({ path: "x" }), true);
  assert.equal(isWholeRead({ path: "x", limit: 5 }), false);
  assert.equal(isWholeRead({ path: "x", offset: 5 }), false);
  assert.equal(isWholeRead({ path: "x", limit: 5, offset: 5 }), false);
});

test("a full read of a small file is allowed", () => {
  assert.equal(decide("read", { path: "small.md" }, opts), null);
});

test("a full read of a big file is blocked with a ctx_execute_file hint", () => {
  const v = decide("read", { path: "big.md" }, opts);
  assert.ok(v, "expected a block");
  assert.match(v.message, /^Blocked:/);
  assert.match(v.message, /ctx_execute_file/);
  assert.match(v.message, /95 KB/);
});

test("a ranged read of a big file is allowed (editing needs the bytes)", () => {
  assert.equal(decide("read", { path: "big.md", limit: 20 }, opts), null);
  assert.equal(decide("read", { path: "big.md", offset: 20 }, opts), null);
});

test("unknown file size is not blocked", () => {
  assert.equal(decide("read", { path: "missing.md" }, opts), null);
});

test("curl and wget in shell are blocked", () => {
  for (const cmd of ["curl https://example.com", "wget https://example.com", "curl -sSL http://x.dev"]) {
    const v = decide("shell", { command: cmd }, opts);
    assert.ok(v, `expected ${cmd} to be blocked`);
    assert.match(v.message, /ctx_fetch_and_index/);
  }
});

test("a shell command that merely mentions curl in a string is not blocked", () => {
  assert.equal(decide("shell", { command: "echo 'curl is a tool'" }, opts), null);
  assert.equal(decide("shell", { command: "Select-String -Pattern 'curl' file.txt" }, opts), null);
  assert.equal(decide("shell", { command: "curl --version" }, opts), null);
});

test("a quoted download command is blocked too", () => {
  const v = decide("shell", { command: 'powershell -Command "curl https://x.dev"' }, opts);
  assert.ok(v, "expected the quoted curl to be blocked");
  assert.match(v.message, /ctx_fetch_and_index/);
});

test("inline HTTP in shell is blocked", () => {
  const v = decide("shell", { command: "node -e \"fetch('https://x.dev')\"" }, opts);
  assert.ok(v);
  assert.match(v.message, /ctx_execute/);
});

test("a whole-file shell dump of a big file is blocked", () => {
  const v = decide("shell", { command: "Get-Content big.md -Raw" }, opts);
  assert.ok(v, "expected the dump to be blocked");
  assert.match(v.message, /ctx_execute_file/);
});

test("a whole-file shell dump of a small file is allowed", () => {
  assert.equal(decide("shell", { command: "cat small.md" }, opts), null);
});

test("a capped shell dump is allowed", () => {
  assert.equal(decide("shell", { command: "Get-Content big.md -TotalCount 50" }, opts), null);
});

test("Code Mode execute reading a big file is blocked", () => {
  const v = decide("execute", { code: 'const r = await tools.read({ path: "big.md" })' }, opts);
  assert.ok(v);
  assert.match(v.message, /ctx_execute_file/);
});

test("Code Mode execute reading a small file is allowed", () => {
  assert.equal(decide("execute", { code: 'await tools.read({ path: "small.md" })' }, opts), null);
});

test("Code Mode execute with curl is blocked", () => {
  const v = decide("execute", { code: 'await tools.shell({ command: "curl https://x.dev" })' }, opts);
  assert.ok(v);
  assert.match(v.message, /ctx_fetch_and_index/);
});

test("unrelated tools are never blocked", () => {
  for (const tool of ["write", "edit", "patch", "glob", "question", "websearch", "subagent"]) {
    assert.equal(decide(tool, { path: "big.md", command: "cat big.md" }, opts), null, tool);
  }
});

test("regexes are exported and usable on their own", () => {
  assert.equal(NET_SHELL.test("curl http://x"), true);
  assert.equal(NET_SHELL.test("wget http://x"), true);
  assert.equal(INLINE_HTTP.test("requests.get('http://x')"), true);
});
