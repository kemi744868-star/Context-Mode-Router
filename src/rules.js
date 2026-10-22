// The routing rules injected into every prompt.
//
// Kept separate so it can be edited without touching the hook logic, and so
// tests can assert on it (e.g. that it names the tools the host actually has).

export const ROUTING = `
<context_window_protection>
context-mode MCP tools are available. Raw tool output is the enemy of your context window, so route through them.

In Code Mode call them like this:
  const r = await tools["context-mode"].ctx_execute_file({ path: "src/app.ts", language: "javascript", code:
    "const n = FILE_CONTENT.split('\\n').length; console.log(n);"
  });
  console.log(r);
(or tools["context-mode"].ctx_execute({ language: "javascript", code: "..." }))

WHEN TO USE WHICH:
- ctx_execute_file(path, language, code): loads a file into a sandbox, runs YOUR code
  over it, and only prints what your code prints. Use it whenever you read a file to
  ANALYZE it (count, filter, extract, list, summarize). A 95 KB file costs a few
  hundred characters this way instead of ~56,000.
- ctx_execute(language, code): run code, only stdout enters the context.
- ctx_fetch_and_index(url, source) then ctx_search(queries): fetch a web page and
  search it, instead of pulling raw HTML into the context.
- ctx_batch_execute(commands, queries): many commands, one combined result.

DO NOT:
- Do not use shell curl or wget. Use ctx_fetch_and_index.
- Do not use inline fetch()/requests.get() in shell code. Use ctx_execute.
- Do not read a large file just to look at it. Use ctx_execute_file.
- Do not grep a large file and read the whole match list. Use ctx_execute_file/ctx_execute.

Use the plain read tool only when you need the exact bytes to EDIT a file.
</context_window_protection>
`.trim();
