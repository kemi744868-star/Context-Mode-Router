// Pure detection helpers. No OpenCode imports, no side effects - so this
// module can be unit tested on its own (node --test).

/**
 * Shell commands that pull raw bytes over the network into the context.
 *
 * Two shapes, both requiring a URL so that ordinary text containing the word
 * "curl" (grep patterns, echo, docs) is not mistaken for a download:
 *   1. curl/wget in command position: `curl https://x`, `cd /tmp && wget ...`
 *   2. curl/wget inside a quoted command: `powershell -Command "curl https://x"`
 */
export const NET_SHELL =
  /(?:^|[|;&(]|\n)\s*(?:sudo\s+)?(?:curl|wget)\b[^\n]*?(?:https?:\/\/|ftp:\/\/)/i;
export const NET_SHELL_QUOTED =
  /["'`][^"'`]*?\b(?:curl|wget)\b[^\n]*?(?:https?:\/\/|ftp:\/\/)/i;

/** Inline HTTP from a script - the response body lands in the context as-is. */
export const INLINE_HTTP = /\bfetch\s*\(\s*['"`]https?:|requests\.(get|post)\s*\(|http\.(get|request)\s*\(/i;

/** A line cap keeps a shell dump small, so those commands are fine. */
const CAP = /-TotalCount\b|-First\b|-Head\b|-n\s*\d+|\|\s*head\s+-n?\s*\d+|Select-Object\s+-First/i;

/** A filter that caps the output of the pipeline it is attached to. */
const CAP_FILTER = /^\s*(?:head\b|Select-Object\b|more\b|-First\b)/i;

/**
 * Paths passed to a read-like call inside a Code Mode `execute` snippet.
 * Matches: read("p"), read({path:"p"}), tools.read({ path: "p" })
 */
export function readPathsIn(code) {
  const out = [];
  const re = /\bread\s*\(\s*\{?\s*(?:path\s*:\s*)?["'`]([^"'`]+)["'`]/g;
  let m;
  while ((m = re.exec(code))) out.push(m[1]);
  return out;
}

/**
 * Whole-file dumps from a shell: cat FILE, type FILE, more FILE, Get-Content FILE.
 *
 * The command is split into statements (`;`, `&&`, newline). A statement that
 * contains a cap anywhere - `head -n 50`, `Select-Object -First 20`,
 * `Get-Content -TotalCount 50` - produces bounded output, so it is skipped.
 * The rest are reported.
 */
export function wholeFileDumps(cmd) {
  const hits = [];
  const statements = String(cmd).split(/;|&&|\n/);
  for (const statement of statements) {
    if (CAP.test(statement)) continue;
    const re = /\b(?:cat|type|more|Get-Content)\s+(-[A-Za-z]+\s+)*["']?([^\s"'>|;&]+)["']?/gi;
    let m;
    while ((m = re.exec(statement))) {
      const path = m[2];
      if (/^\d+$/.test(path)) continue;
      hits.push(path);
    }
  }
  return hits;
}

/** A read without a limit/offset returns the whole file into the context. */
export function isWholeRead(input) {
  return input?.limit === undefined && input?.offset === undefined;
}

function isNetDownload(cmd) {
  return NET_SHELL.test(cmd) || NET_SHELL_QUOTED.test(cmd);
}

/**
 * Decide whether a tool call should be denied.
 *
 * @param {string} tool      tool name as reported by OpenCode v2
 * @param {object} input     tool input
 * @param {object} opts
 * @param {(p: string) => number} opts.sizeOf  file size in bytes, -1 if unknown
 * @param {number} opts.bigFileBytes           threshold above which a full read is denied
 * @returns {{reason: string, message: string} | null}
 */
export function decide(tool, input, { sizeOf, bigFileBytes }) {
  const blocked = (message) => ({ reason: "blocked", message });

  if (tool === "read") {
    if (!isWholeRead(input)) return null;
    const size = sizeOf(input.path);
    if (size <= bigFileBytes) return null;
    return blocked(
      `Blocked: ${input.path} is ${Math.round(size / 1024)} KB and a full read would put all of it into the ` +
        `context window. Use context-mode.ctx_execute_file instead - pass path="${input.path}", ` +
        `language="javascript", and code that prints only what you need (a count, the matching lines, a summary). ` +
        `If you need the exact bytes to EDIT the file, read a range instead (limit/offset) or use the edit tool.`
    );
  }

  if (tool === "shell") {
    const cmd = String(input?.command ?? "");
    if (isNetDownload(cmd)) {
      return blocked(
        "Blocked: curl/wget put the whole response into the context. " +
          "Use context-mode.ctx_fetch_and_index(url, source) and then context-mode.ctx_search(queries)."
      );
    }
    if (INLINE_HTTP.test(cmd)) {
      return blocked(
        "Blocked: an inline HTTP call puts the whole response into the context. " +
          "Use context-mode.ctx_execute(language, code) - only stdout enters the context."
      );
    }
    for (const p of wholeFileDumps(cmd)) {
      const size = sizeOf(p);
      if (size > bigFileBytes) {
        return blocked(
          `Blocked: '${p}' is ${Math.round(size / 1024)} KB and dumping it whole would put all of it into the ` +
            `context window. Use context-mode.ctx_execute_file instead - pass path="${p}", language="javascript", ` +
            `and code that prints only what you need. ` +
            `Or cap the output in the shell (head -n 50 / Select-Object -First 50).`
        );
      }
    }
  }

  // Code Mode: one `execute` tool whose `code` calls the other tools.
  if (tool === "execute") {
    const code = String(input?.code ?? "");
    for (const p of readPathsIn(code)) {
      const size = sizeOf(p);
      if (size > bigFileBytes) {
        return blocked(
          `Blocked: ${p} is ${Math.round(size / 1024)} KB and reading it whole would put all of it into the ` +
            `context window. Use context-mode.ctx_execute_file instead - pass path="${p}", language="javascript", ` +
            `and code that prints only what you need.`
        );
      }
    }
    if (isNetDownload(code)) {
      return blocked(
        "Blocked: curl/wget put the whole response into the context. " +
          "Use context-mode.ctx_fetch_and_index(url, source) and then context-mode.ctx_search(queries)."
      );
    }
    if (INLINE_HTTP.test(code)) {
      return blocked(
        "Blocked: an inline HTTP call puts the whole response into the context. " +
          "Use context-mode.ctx_execute(language, code) - only stdout enters the context."
      );
    }
  }

  return null;
}
