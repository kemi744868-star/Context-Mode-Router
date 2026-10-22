// Tests for the plugin wiring: the fake ctx below mirrors the shapes that
// OpenCode v2.0.32 actually passes to the hooks (verified by probing the
// binary - see README "v2 API notes").
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { ROUTING } from "../src/index.js";

// A real file on disk: the plugin sizes paths with fs.statSync, so the test
// needs a real one to exercise the threshold.
const DIR = mkdtempSync(join(tmpdir(), "cmr-test-"));
const BIG = join(DIR, "big.md");
writeFileSync(BIG, "x".repeat(95 * 1024));
const SMALL = join(DIR, "small.md");
writeFileSync(SMALL, "x".repeat(512));

function fakeCtx() {
  const calls = { session: [], tool: [] };
  return {
    calls,
    location: { project: { canonical: "C:/project" }, directory: "C:/project" },
    session: {
      hook(name, handler) {
        calls.session.push({ name, handler });
      },
    },
    tool: {
      hook(name, handler) {
        calls.tool.push({ name, handler });
      },
    },
  };
}

test("plugin registers a prompt hook and a tool hook", async () => {
  const ctx = fakeCtx();
  await plugin.setup(ctx);
  assert.equal(ctx.calls.session.length, 1);
  assert.equal(ctx.calls.session[0].name, "prompt");
  assert.equal(ctx.calls.tool.length, 1);
  assert.equal(ctx.calls.tool[0].name, "execute.before");
});

test("prompt hook appends the routing rules to prompt.text", async () => {
  const ctx = fakeCtx();
  await plugin.setup(ctx);
  const handler = ctx.calls.session[0].handler;
  const event = { prompt: { text: "read the repo", files: [] } };
  await handler(event);
  assert.ok(event.prompt.text.startsWith("read the repo"));
  assert.ok(event.prompt.text.includes("<context_window_protection>"));
  // prompt must stay an object - assigning a string here crashes the server
  assert.equal(typeof event.prompt, "object");
  assert.equal(typeof event.prompt.text, "string");
});

test("prompt hook does not append the rules twice", async () => {
  const ctx = fakeCtx();
  await plugin.setup(ctx);
  const handler = ctx.calls.session[0].handler;
  const event = { prompt: { text: "hi" } };
  await handler(event);
  const once = event.prompt.text;
  await handler(event);
  assert.equal(event.prompt.text, once);
});

test("prompt hook survives a malformed payload", async () => {
  const ctx = fakeCtx();
  await plugin.setup(ctx);
  const handler = ctx.calls.session[0].handler;
  await handler({});            // no prompt
  await handler({ prompt: {} }); // no text
  await handler(null);
});

test("tool hook denies a full read of a big file and names the alternative", async () => {
  const ctx = fakeCtx();
  await plugin.setup(ctx);
  const handler = ctx.calls.tool[0].handler;
  await assert.rejects(
    () => handler({ tool: "read", input: { path: BIG } }),
    /Blocked:.*ctx_execute_file/s
  );
});

test("tool hook allows a ranged read", async () => {
  const ctx = fakeCtx();
  await plugin.setup(ctx);
  const handler = ctx.calls.tool[0].handler;
  await handler({ tool: "read", input: { path: BIG, limit: 20 } });
  await handler({ tool: "read", input: { path: SMALL } });
});

test("tool hook never throws for unknown tools", async () => {
  const ctx = fakeCtx();
  await plugin.setup(ctx);
  const handler = ctx.calls.tool[0].handler;
  await handler({ tool: "write", input: { path: BIG } });
  await handler({ tool: "glob", input: { pattern: "**/*" } });
  await handler({});
});

test("CONTEXT_MODE_ROUTER=off disables both hooks", async () => {
  const prev = process.env.CONTEXT_MODE_ROUTER;
  process.env.CONTEXT_MODE_ROUTER = "off";
  try {
    const ctx = fakeCtx();
    await plugin.setup(ctx);
    const event = { prompt: { text: "read the repo" } };
    await ctx.calls.session[0].handler(event);
    assert.equal(event.prompt.text, "read the repo");

    // a big read must pass through untouched
    await ctx.calls.tool[0].handler({ tool: "read", input: { path: BIG } });
  } finally {
    if (prev === undefined) delete process.env.CONTEXT_MODE_ROUTER;
    else process.env.CONTEXT_MODE_ROUTER = prev;
  }
});

test("CONTEXT_MODE_ROUTER_MAX_BYTES raises the threshold", async () => {
  const prev = process.env.CONTEXT_MODE_ROUTER_MAX_BYTES;
  process.env.CONTEXT_MODE_ROUTER_MAX_BYTES = String(1024 * 1024);
  try {
    const ctx = fakeCtx();
    await plugin.setup(ctx);
    await ctx.calls.tool[0].handler({ tool: "read", input: { path: BIG } });
  } finally {
    if (prev === undefined) delete process.env.CONTEXT_MODE_ROUTER_MAX_BYTES;
    else process.env.CONTEXT_MODE_ROUTER_MAX_BYTES = prev;
  }
});

test("the routing rules name the context-mode tools", () => {
  for (const t of ["ctx_execute_file", "ctx_execute", "ctx_fetch_and_index", "ctx_search"]) {
    assert.ok(ROUTING.includes(t), `routing should mention ${t}`);
  }
});
