# opencode-context-mode-router

Routing enforcement for [context-mode](https://github.com/mksglu/context-mode) on **OpenCode v2**.

context-mode sandboxes tool output so raw data never enters the agent's context window.
On Claude Code that works out of the box, because its plugin can intercept tool calls.
**On OpenCode v2 it does not** - and for a while it looked like it did, which is worth
explaining, because the failure is silent.

## Why this exists

context-mode ships an OpenCode plugin that exports the KiloCode shape:

```js
export default { id: "context-mode", server: createContextModePlugin };
```

OpenCode v2's plugin loader only accepts:

```js
export default { id: "...", effect: ... }   // or
export default { id: "...", setup: async (ctx) => { ... } };
```

So the upstream plugin never loads. The only symptom is one WARN line per server start:

```
failed to load plugin target=context-mode
  PluginModule.LoadError: Plugin must export a default definition with an id and an effect or setup function.
```

context-mode still works as an **MCP server**, so the `ctx_*` tools are registered and
callable. What is missing is the part that makes the sandbox worth having: **routing
enforcement**. Nothing tells the model to prefer `ctx_execute_file` over `read`, so it
keeps reading whole files into the context.

Measured on a 95 KB file, same model, same question:

| | tool output into context | input tokens |
|---|---|---|
| context-mode installed, no routing | 56,681 B | 23,608 |
| with this plugin | 646 B | 4,415 |
| | **-98.9%** | **-81%** |

This plugin re-implements only the routing layer. The sandbox, the FTS5 knowledge base
and the MCP server remain context-mode's job.

## Install

1. Install context-mode as an MCP server (11 tools):

```jsonc
// ~/.config/opencode/opencode.json
{
  "mcp": {
    "servers": {
      "context-mode": {
        "type": "local",
        "command": ["node", "<path>/context-mode/cli.bundle.mjs"]
      }
    }
  }
}
```

2. Install this plugin:

```powershell
git clone https://github.com/<you>/opencode-context-mode-router
cd opencode-context-mode-router
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

The script copies the plugin into `~/.config/opencode/plugins/context-mode-router` and
registers it in `opencode.json`. Restart OpenCode afterwards.

## What it does

**Injects routing rules into every prompt** (`ctx.session.hook("prompt")`), naming the
tools and when to use each one.

**Denies the calls that flood the context** (`ctx.tool.hook("execute.before")`):

| call | why it is denied |
|---|---|
| `read` of a file over the threshold, no `limit`/`offset` | the whole file would enter the context |
| `shell` with `curl` / `wget` | the whole response would enter the context |
| `shell` with inline `fetch()` / `requests.get()` | same |
| `shell` dumping a whole file (`cat`, `Get-Content`, `type`, `more`) | same |
| `execute` (Code Mode) whose code reads a big file | same |

The denial message names the tool to use instead, so the model can recover in one step.
A ranged read (`limit`/`offset`) is always allowed - editing a file needs the exact bytes.

## Configuration

| variable | default | meaning |
|---|---|---|
| `CONTEXT_MODE_ROUTER` | on | set to `off` to disable everything |
| `CONTEXT_MODE_ROUTER_MAX_BYTES` | `24576` | full-read threshold in bytes |
| `CONTEXT_MODE_ROUTER_NO_RULES` | off | set to `1` to keep the hard blocks but skip prompt injection |

## v2 API notes

Learned by probing the OpenCode v2 binary; these are the parts that are easy to get wrong.

- **`session.hook("prompt")` payload** is `{ sessionID, messageID, prompt: { text, files }, metadata, delivery }`.
  `prompt` is an **object**. Assigning a string to `payload.prompt` crashes the server with
  a 500 - mutate `payload.prompt.text` instead.
- **`tool.hook("execute.before")` payload** is `{ tool, sessionID, agent, messageID, id, input }`.
  **Throwing inside the hook denies the call**; the model sees the message and can route
  to the sandbox tool instead.
- **Tool names in v2**: `read`, `write`, `edit`, `patch`, `glob`, `grep`, `shell`, `webfetch`,
  `websearch`, `question`, `skill`, `subagent`, `execute`.
- **Code Mode wraps everything in one `execute` tool** whose `code` string contains the
  real call, e.g. `tools.read({ path: "src/app.ts" })`. The same checks have to be applied
  to that string, otherwise a big file read through Code Mode slips past.
- The v2 plugin API is also available as TypeScript types in
  `@opencode-ai/plugin` under `dist/v2`.

## The model will route around you

Soft rules in an `AGENTS.md` were not enough: with the official context-mode routing
rules in the project directory, the model still read the whole file. A hard block works,
but the model then looks for another way - `Get-Content -Raw`, `grep` with a big limit,
a script that prints the file. This plugin closes the common doors, but the arms race is
heuristic, not semantic. Expect to add rules as new escape routes show up.

## Development

```bash
npm test          # 31 tests, node --test, no dependencies
```

`src/detect.js` holds the pure logic (no OpenCode imports) so it can be tested on its own;
`src/index.js` only wires it to the hooks. `src/rules.js` holds the prompt text.

## License

MIT
