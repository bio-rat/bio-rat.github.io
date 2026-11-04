/* ChefNMR2 client: calls the public ChefNMR2 Hugging Face Space through Gradio's HTTP API (free, shared GPU,
 * per-visitor quota) and returns its answer: {candidates:[{smiles,votes,vote_fraction}], n_samples, n_valid, ...}.
 *
 * No DOM here, so it can be tested under Node (tests/test_client.cjs).
 */
(function (root) {
  "use strict";

  const FORMULA_RE = /^(?:[A-Z][a-z]?\d*)+$/;

  /** Cheap pre-flight checks so obvious mistakes fail instantly. The backends re-validate everything. */
  function preflight(input) {
    const formula = (input.formula || "").trim();
    if (!FORMULA_RE.test(formula)) {
      throw new Error("The molecular formula should be element symbols with counts only, e.g. C17H19NO3.");
    }
    const symbols = [...formula.matchAll(/([A-Z][a-z]?)(\d*)/g)].map((m) => m[1]);
    if (!symbols.includes("H")) {
      throw new Error("The formula must include hydrogens (e.g. C20H28O5, not C20O5).");
    }
    if (!(input.c13 || "").trim() && !(input.h1 || "").trim()) {
      throw new Error("Enter at least one 13C or 1H peak.");
    }
    const n = Number(input.n_samples);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error("Samples must be a whole number from 1 to 1000.");
    const seed = Number(input.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) throw new Error("Seed must be a whole number from 0 to 4294967295.");
    return { formula, c13: input.c13 || "", h1: input.h1 || "", n_samples: n, seed };
  }

  /** Parse a Gradio server-sent-events body into [{event, data}] (data is the raw text after "data:"). */
  function parseSSE(text) {
    const events = [];
    for (const block of text.replace(/\r\n/g, "\n").split("\n\n")) {
      let event = "message";
      const data = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (block.trim()) events.push({ event, data: data.join("\n") });
    }
    return events;
  }

  /** Gradio 6 sends errors as {"error": "...", "title": "..."}; older versions send a bare string. */
  function gradioErrorMessage(raw) {
    let m = raw;
    try { m = JSON.parse(raw); } catch (_) { /* raw text */ }
    if (m && typeof m === "object") m = m.error || m.message || m.title;
    if (typeof m === "string" && m.trim() && m.trim() !== "null") return m.trim();
    return "The Space reported an error without a message.";
  }

  function withTimeout(ms, signal) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error("timeout")), ms);
    if (signal) signal.addEventListener("abort", () => ctl.abort(signal.reason));
    return { signal: ctl.signal, done: () => clearTimeout(timer) };
  }

  async function readError(res) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
      else if (j && j.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch (_) { /* keep the status text */ }
    return msg;
  }

  /** The public Hugging Face Space (Gradio API). */
  async function runSpace(base, input, opts = {}) {
    base = base.replace(/\/$/, "");
    const t = withTimeout(opts.timeoutMs || 300000, opts.signal);
    try {
      const post = await fetch(`${base}/gradio_api/call/elucidate_structure`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: [input.formula, input.c13, input.h1, input.n_samples, input.seed] }),
        signal: t.signal,
      });
      if (!post.ok) throw new Error(await readError(post));
      const { event_id } = await post.json();
      if (!event_id) throw new Error("The Space did not return an event id.");
      // The stream stays open until the GPU slot has run (ZeroGPU may queue first), then closes.
      const res = await fetch(`${base}/gradio_api/call/elucidate_structure/${encodeURIComponent(event_id)}`, { signal: t.signal });
      if (!res.ok) throw new Error(await readError(res));
      const events = parseSSE(await res.text());
      const err = events.find((e) => e.event === "error");
      if (err) throw new Error(gradioErrorMessage(err.data));
      const done = events.find((e) => e.event === "complete");
      if (!done) throw new Error("The Space closed the stream without an answer.");
      const payload = JSON.parse(done.data);
      return typeof payload[0] === "string" ? JSON.parse(payload[0]) : payload[0];
    } finally {
      t.done();
    }
  }

  const api = { preflight, parseSSE, gradioErrorMessage, runSpace };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ChefNMR = api;
})(typeof window !== "undefined" ? window : globalThis);
