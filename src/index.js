// opencode-context-mode-router
//
// Routing enforcement for context-mode on OpenCode v2.
//
// Why this exists
// ---------------
// context-mode ships an OpenCode plugin, but it exports the KiloCode shape
// { id, server }. OpenCode v2's plugin loader wants { id, effect | setup }, so
// the upstream plugin never loads (PluginModule.LoadError) and the part that
// makes the sandbox useful - hook-based routing - is lost. context-mode still
// runs as an MCP server, so the ctx_* tools are there; nothing steers the
// model to them, so it keeps using read/grep/curl and floods the context.
//
// Measured on a 95 KB README with the same model and the same question:
//
//   routing off : 56,681 B of tool output, 23,608 input tokens
//   routing on  :    646 B of tool output,  4,415 input tokens   (-98.9% / -81%)
//
// This plugin re-implements just the routing layer on the v2 plugin API:
//   ctx.session.hook("prompt")     - inject the routing rules
//   ctx.tool.hook("execute.before") - deny calls that would flood the context
//
// Everything else (the sandbox, the FTS5 knowledge base, the MCP server) is
// still context-mode's job.
//
// v2 API notes, learned by probing the binary (see README):
//   - session.hook("prompt") payload: { sessionID, messageID, prompt: {text, files}, ... }
//     prompt is an OBJECT. Assigning a string to payload.prompt crashes the
//     server with a 500. Mutate payload.prompt.text instead.
//   - tool.hook("execute.before") payload: { tool, sessionID, agent, messageID, id, input }
//     Throwing inside the hook denies the call; the model sees the message and
//     can route to the ctx_* tool instead.
//   - Tool names in v2: read, write, edit, patch, glob, grep, shell, webfetch,
//     websearch, question, skill, subagent, execute (Code Mode).
//   - In Code Mode the model calls the other tools from inside one `execute`
//     tool, whose `code` string contains e.g. tools.read({ path: "..." }).
//
// Configuration (environment variables):
//   CONTEXT_MODE_ROUTER=off            disable every check
//   CONTEXT_MODE_ROUTER_MAX_BYTES=N    full-read threshold in bytes (default 24576)
//   CONTEXT_MODE_ROUTER_NO_RULES=1     skip prompt injection, keep the hard blocks

import { statSync } from "node:fs";
import { decide } from "./detect.js";
import { ROUTING } from "./rules.js";

const DEFAULT_MAX_BYTES = 24 * 1024;

// Project root, used to resolve relative paths. Set in setup().
let ROOT = process.cwd();

function resolvePath(p) {
  if (typeof p !== "string" || !p) return p;
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/")) return p;
  return ROOT.replace(/[\\/]+$/, "") + "\\" + p.replace(/\//g, "\\");
}

function sizeOf(path) {
  if (typeof path !== "string" || !path) return -1;
  try {
    return statSync(resolvePath(path)).size;
  } catch {
    return -1;
  }
}

function envFlag(name) {
  const v = String(process.env[name] ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

function enabled() {
  const v = String(process.env.CONTEXT_MODE_ROUTER ?? "").toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no" || v === "disabled");
}

function maxBytes() {
  const raw = Number(process.env.CONTEXT_MODE_ROUTER_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BYTES;
}

export default {
  id: "context-mode-router",

  setup: async (ctx) => {
    try {
      ROOT = ctx?.location?.project?.canonical || ctx?.location?.directory || process.cwd();
    } catch {
      /* keep cwd */
    }

    // 1. Tell the model the tools exist and which one to use.
    if (!envFlag("CONTEXT_MODE_ROUTER_NO_RULES")) {
      ctx.session.hook("prompt", async (event) => {
        if (!enabled()) return;
        try {
          const text = event?.prompt?.text;
          if (typeof text === "string" && !text.includes("<context_window_protection>")) {
            event.prompt.text = `${text}\n\n${ROUTING}`;
          }
        } catch {
          // never break the turn
        }
      });
    }

    // 2. Enforce it: deny the calls that would flood the context window.
    ctx.tool.hook("execute.before", async (event) => {
      if (!enabled()) return;
      try {
        const verdict = decide(event?.tool, event?.input ?? {}, { sizeOf, bigFileBytes: maxBytes() });
        if (verdict) throw new Error(verdict.message);
      } catch (e) {
        // Rethrow only our own blocks; swallow anything unexpected.
        if (String(e?.message ?? "").startsWith("Blocked:")) throw e;
      }
    });
  },
};

export { decide, ROUTING };
