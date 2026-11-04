// Tests for docs/chefnmr.js (no DOM). Run:  node tests/test_client.cjs [--live]
// --live also calls the real public ChefNMR2 Space once with the quickstart molecule (uses a few seconds of its GPU quota).
const assert = require("assert");
const path = require("path");
const C = require(path.join(__dirname, "..", "docs", "chefnmr.js"));

const realFetch = global.fetch;
let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log("ok   -", name); } catch (e) { failed++; console.log("FAIL -", name, "\n      ", e && e.stack || e); }
}
const good = { formula: "C17H19NO3", c13: "145.2, 138.0", h1: "6.63, 1, d", n_samples: "100", seed: "0" };

function mockFetch(routes) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const r = routes.find((x) => url.includes(x.match) && (x.method || "GET") === (init.method || "GET"));
    if (!r) throw new Error("unexpected request " + url);
    return {
      ok: (r.status || 200) < 400, status: r.status || 200,
      json: async () => r.json, text: async () => r.text,
    };
  };
  return calls;
}

(async () => {
  await t("preflight accepts a good request and normalises numbers", () => {
    const x = C.preflight(good);
    assert.strictEqual(x.n_samples, 100); assert.strictEqual(x.seed, 0); assert.strictEqual(x.formula, "C17H19NO3");
  });
  await t("preflight rejects structural formulas, missing H, no peaks, bad counts", () => {
    assert.throws(() => C.preflight({ ...good, formula: "(CH3)2CHOH" }), /formula/);
    assert.throws(() => C.preflight({ ...good, formula: "C20O5" }), /hydrogens/);
    assert.throws(() => C.preflight({ ...good, c13: "", h1: "" }), /at least one/i);
    assert.throws(() => C.preflight({ ...good, n_samples: "0" }), /Samples/);
    assert.throws(() => C.preflight({ ...good, n_samples: "1001" }), /Samples/);
    assert.throws(() => C.preflight({ ...good, seed: "-1" }), /Seed/);
    assert.throws(() => C.preflight({ ...good, n_samples: "1.5" }), /Samples/);
  });
  await t("parseSSE reads Gradio events (complete, heartbeat, error)", () => {
    const ev = C.parseSSE('event: heartbeat\ndata: null\n\nevent: complete\ndata: ["{\\"a\\":1}"]\n\n');
    assert.deepStrictEqual(ev.map((e) => e.event), ["heartbeat", "complete"]);
    assert.deepStrictEqual(JSON.parse(ev[1].data), ['{"a":1}']);
    assert.strictEqual(C.parseSSE("event: error\ndata: \"boom\"\r\n\r\n")[0].event, "error");
  });

  const answer = { candidates: [{ smiles: "CCO", votes: 9, vote_fraction: 0.9 }], n_samples: 10, n_valid: 10, timing_s: { total: 1 } };
  await t("runSpace posts the 5 positional args, then reads the result stream", async () => {
    const calls = mockFetch([
      { match: "/gradio_api/call/elucidate_structure/EID", text: "event: heartbeat\ndata: null\n\nevent: complete\ndata: " + JSON.stringify([JSON.stringify(answer)]) + "\n\n" },
      { match: "/gradio_api/call/elucidate_structure", method: "POST", json: { event_id: "EID" } },
    ]);
    const out = await C.runSpace("https://space.example/", C.preflight(good));
    assert.deepStrictEqual(out, answer);
    assert.deepStrictEqual(JSON.parse(calls[0].init.body), { data: ["C17H19NO3", "145.2, 138.0", "6.63, 1, d", 100, 0] });
    assert.strictEqual(calls[0].url, "https://space.example/gradio_api/call/elucidate_structure");
  });
  await t("runSpace surfaces a Gradio error message", async () => {
    mockFetch([
      { match: "/gradio_api/call/elucidate_structure/EID", text: 'event: error\ndata: "No GPU quota left"\n\n' },
      { match: "/gradio_api/call/elucidate_structure", method: "POST", json: { event_id: "EID" } },
    ]);
    await assert.rejects(() => C.runSpace("https://space.example", C.preflight(good)), /No GPU quota left/);
  });
  await t("runSpace: Gradio 6 error object (format captured from the live Space) gives its message", async () => {
    const wire = JSON.stringify({ error: "1H peak 1 ('1.2, 3'): no multiplicity; every 1H peak needs one", duration: 10, visible: true, title: "Error" });
    mockFetch([
      { match: "/gradio_api/call/elucidate_structure/EID", text: "event: error\ndata: " + wire + "\n\n" },
      { match: "/gradio_api/call/elucidate_structure", method: "POST", json: { event_id: "EID" } },
    ]);
    await assert.rejects(() => C.runSpace("https://space.example", C.preflight(good)), /no multiplicity/);
  });
  await t("gradioErrorMessage: string, object, null and empty forms", () => {
    assert.strictEqual(C.gradioErrorMessage('"plain"'), "plain");
    assert.strictEqual(C.gradioErrorMessage('{"error":"x","title":"T"}'), "x");
    assert.strictEqual(C.gradioErrorMessage('{"title":"ZeroGPU quota exceeded"}'), "ZeroGPU quota exceeded");
    assert.match(C.gradioErrorMessage("null"), /without a message/);
    assert.match(C.gradioErrorMessage(""), /without a message/);
  });
  await t("runSpace: stream with no complete event is an error", async () => {
    mockFetch([
      { match: "/gradio_api/call/elucidate_structure/EID", text: "event: heartbeat\ndata: null\n\n" },
      { match: "/gradio_api/call/elucidate_structure", method: "POST", json: { event_id: "EID" } },
    ]);
    await assert.rejects(() => C.runSpace("https://space.example", C.preflight(good)), /without an answer/);
  });
  if (process.argv.includes("--live")) {
    global.fetch = realFetch; // Node's real fetch, not the mock
    await t("LIVE: public Space returns morphine as the top structure", async () => {
      const input = C.preflight({
        formula: "C17H19NO3",
        c13: "146.4, 138.6, 133.5, 128.8, 127.4, 124.9, 119.5, 116.7, 91.4, 66.4, 58.8, 46.8, 43.0, 42.7, 40.7, 35.7, 20.5",
        h1: "6.72, 1, d\n6.55, 1, d\n5.70, 1, d\n5.26, 1, d\n4.86, 1, d\n4.16, 1, m\n3.32, 1, m\n2.98, 1, d\n2.85, 1, m\n2.57, 1, dd\n2.42, 3, s\n2.28, 1, td\n2.05, 1, m\n1.86, 1, m\n1.60, 1, m",
        n_samples: 100, seed: 0,
      });
      const t0 = Date.now();
      let out;
      try { out = await C.runSpace("https://ziyux123-chefnmr2.hf.space", input); }
      catch (e) {
        if (/runs limit|quota/i.test(e.message)) { console.log("      SKIPPED: the Space's anonymous GPU quota for this network is used up:", e.message.slice(0, 80)); return; }
        throw e;
      }
      console.log(`      ${((Date.now() - t0) / 1000).toFixed(1)} s; top ${out.candidates[0].smiles} ${out.candidates[0].vote_fraction}`);
      assert.strictEqual(out.candidates[0].smiles, "CN1CCC23c4c5ccc(O)c4OC2C(O)C=CC3C1C5");
    });
    await t("LIVE: public Space reports a bad formula as a readable error", async () => {
      await assert.rejects(
        () => C.runSpace("https://ziyux123-chefnmr2.hf.space", { formula: "(CH3)2CHOH", c13: "10.0", h1: "", n_samples: 10, seed: 0 }),
        (e) => { console.log("      message:", e.message.slice(0, 160)); return /formula/i.test(e.message); });
    });
  }

  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
})();
