/* Page logic: fills the form, calls the public Space (chefnmr.js), draws the ranked structures with RDKit.js.
 * Response strings are only ever inserted with textContent; the one innerHTML-like insertion is RDKit's own SVG,
 * parsed as XML with scripts stripped. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const SITE = window.SITE || {};
  const EXAMPLES = window.EXAMPLES || [];

  // ---- personalise from site.config.js -----------------------------------------------------------------
  document.title = `${SITE.name || "Portfolio"} — portfolio`;
  $("brand").textContent = SITE.name || "Portfolio";
  $("hero-name").textContent = SITE.name || "Portfolio";
  $("hero-tagline").textContent = SITE.tagline || "";
  $("hero-intro").textContent = SITE.intro || "";
  for (const id of ["nav-github", "about-github"]) {
    if (SITE.github) $(id).href = SITE.github;
    else $(id).hidden = true;
  }
  $("year").textContent = new Date().getFullYear();

  // ---- where the data goes -----------------------------------------------------------------------------
  const hostOf = (u) => { try { return new URL(u).host; } catch (_) { return u; } };
  $("privacy").textContent =
    `Your input is sent to ${hostOf(SITE.spaceUrl)} (the ChefNMR2 authors' public Space on Hugging Face) to run the model. ` +
    "This page itself stores nothing. Don't submit unpublished or confidential spectra.";

  // ---- examples ----------------------------------------------------------------------------------------
  const sel = $("example");
  EXAMPLES.forEach((ex, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = `${ex.name} — ${ex.formula}`;
    sel.appendChild(o);
  });
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = "Your own data";
  sel.appendChild(custom);

  function loadExample(i) {
    const ex = EXAMPLES[i];
    if (!ex) return;
    $("formula").value = ex.formula;
    $("c13").value = ex.c13;
    $("h1").value = ex.h1;
  }
  const morphineIdx = Math.max(0, EXAMPLES.findIndex((e) => e.name === "morphine"));
  sel.value = String(morphineIdx);
  loadExample(morphineIdx);
  sel.addEventListener("change", () => { if (sel.value !== "custom") loadExample(Number(sel.value)); });
  ["formula", "c13", "h1"].forEach((id) => $(id).addEventListener("input", () => { sel.value = "custom"; }));

  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  function reportedFor(input) {
    const ex = EXAMPLES.find((e) => norm(e.formula) === norm(input.formula) && norm(e.c13) === norm(input.c13) && norm(e.h1) === norm(input.h1));
    return ex ? ex.reported : null;
  }

  // ---- RDKit.js (vendored, loaded on first use) ---------------------------------------------------------
  let rdkitPromise = null;
  function loadRDKit() {
    if (!rdkitPromise) {
      rdkitPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "vendor/rdkit/RDKit_minimal.js";
        s.onload = () => window.initRDKitModule({ locateFile: (f) => "vendor/rdkit/" + f }).then(resolve, reject);
        s.onerror = () => reject(new Error("RDKit.js could not be loaded"));
        document.head.appendChild(s);
      });
    }
    return rdkitPromise;
  }

  function svgNode(RDKit, smiles) {
    const mol = RDKit.get_mol(smiles);
    if (!mol) return null;
    try {
      if (!mol.is_valid()) return null;
      const doc = new DOMParser().parseFromString(mol.get_svg(260, 190), "image/svg+xml");
      doc.querySelectorAll("script, foreignObject").forEach((n) => n.remove());
      const el = doc.documentElement;
      if (!el || el.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) return null;
      el.removeAttribute("width"); el.removeAttribute("height");
      return document.importNode(el, true);
    } finally {
      mol.delete();
    }
  }

  // Planar (stereo-blind) canonical SMILES, as the paper compares structures. Stereo is removed at the SMILES text
  // level (chirality @/@@ and bond directions / \), which leaves every atom's hydrogen count unchanged.
  const stripStereo = (s) => s.replace(/@/g, "").replace(/[/\\]/g, "");
  function planarSmiles(RDKit, smiles) {
    const mol = RDKit.get_mol(stripStereo(smiles));
    if (!mol) return null;
    try {
      if (!mol.is_valid()) return null;
      return mol.get_smiles();
    } catch (_) {
      return null;
    } finally {
      mol.delete();
    }
  }

  // ---- status / results --------------------------------------------------------------------------------
  const statusEl = $("status");
  function setStatus(text, kind) {
    statusEl.hidden = !text;
    statusEl.textContent = text || "";
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  let lastAnswer = null;

  async function render(answer, input, via, reported) {
    lastAnswer = { via, input, answer };
    $("placeholder").hidden = true;
    $("results").hidden = false;

    const n = answer.n_samples, valid = answer.n_valid;
    const cands = answer.candidates || [];
    const t = answer.timing_s && answer.timing_s.total;
    $("summary").textContent =
      `${n} samples · ${valid} gave a structure · ${cands.length} candidate${cands.length === 1 ? "" : "s"}` +
      (t != null ? ` · ${t} s on the GPU` : "") + ` · ${via}`;

    // Only the "nothing came out" case gets a message; a prior run's message must not linger.
    const hint = $("hint");
    hint.hidden = cands.length > 0;
    if (!cands.length) {
      hint.textContent = "No sample gave a valid structure. Check the formula and peak lists.";
      hint.className = "hint warn";
    }

    let RDKit = null;
    try { RDKit = await loadRDKit(); } catch (_) { /* fall back to SMILES text */ }
    const reportedPlanar = RDKit && reported ? planarSmiles(RDKit, reported) : null;

    const list = $("cands");
    list.replaceChildren();
    cands.forEach((c, i) => {
      const li = el("li", "cand" + (i === 0 ? " top" : ""));
      const pic = el("div", "pic");
      const svg = RDKit ? svgNode(RDKit, c.smiles) : null;
      if (svg) pic.appendChild(svg); else pic.appendChild(el("span", "nopic", "no drawing"));
      const body = el("div", "body");
      const head = el("div", "headline");
      head.appendChild(el("span", "rank", `#${i + 1}`));
      head.appendChild(el("b", "pct", `${(c.vote_fraction * 100).toFixed(1)}%`));
      head.appendChild(el("span", "votes", `${c.votes} sample${c.votes === 1 ? "" : "s"}`));
      if (reportedPlanar && RDKit && planarSmiles(RDKit, c.smiles) === reportedPlanar) {
        head.appendChild(el("span", "match", "matches the reported structure"));
      }
      const bar = el("div", "bar"); const fill = el("i"); fill.style.width = `${Math.max(1, c.vote_fraction * 100)}%`; bar.appendChild(fill);
      const smi = el("code", "smi", c.smiles);
      const copy = el("button", "ghost small", "Copy SMILES");
      copy.type = "button";
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(c.smiles); copy.textContent = "Copied"; } catch (_) { copy.textContent = "Copy failed"; }
        setTimeout(() => { copy.textContent = "Copy SMILES"; }, 1500);
      });
      body.append(head, bar, smi, copy);
      li.append(pic, body);
      list.appendChild(li);
    });

    const imp = answer.implausible_candidates || [];
    $("implausible-box").hidden = imp.length === 0;
    const impList = $("implausible");
    impList.replaceChildren();
    imp.forEach((c) => impList.appendChild(el("li", "", `${c.smiles} — ${c.votes} sample${c.votes === 1 ? "" : "s"}`)));
  }

  // ---- run ---------------------------------------------------------------------------------------------
  let running = false, ticker = null;
  $("form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (running) return;
    let input;
    try {
      input = window.ChefNMR.preflight({
        formula: $("formula").value, c13: $("c13").value, h1: $("h1").value,
        n_samples: $("n").value, seed: $("seed").value,
      });
    } catch (e) { setStatus(e.message, "error"); return; }

    const via = "public ChefNMR2 Space";
    running = true;
    $("run").disabled = true;
    const t0 = Date.now();
    const tick = () => setStatus(`Running on the public Space's GPU (1000 samples can take up to a minute) — ${Math.round((Date.now() - t0) / 1000)} s`);
    tick(); ticker = setInterval(tick, 1000);
    loadRDKit().catch(() => {}); // fetch the drawing library while the GPU works

    try {
      const answer = await window.ChefNMR.runSpace(SITE.spaceUrl, input);
      if (!answer || !Array.isArray(answer.candidates)) throw new Error("The Space returned an unexpected answer.");
      setStatus("");
      await render(answer, input, via, reportedFor(input));
    } catch (e) {
      let msg = e && e.message ? e.message : String(e);
      if (e && (e.name === "AbortError" || /timeout/i.test(msg))) msg = "The request timed out. Try fewer samples or try again in a minute.";
      else if (/failed to fetch|networkerror|load failed/i.test(msg)) msg = "Could not reach the public Space (it may be restarting or you may be offline). Try again in a minute.";
      else if (/runs limit|quota|zerogpu/i.test(msg)) msg = "The public Space's free GPU allowance for your network is used up for now (it is per visitor and resets daily; anonymous visitors get only a few runs). Try again later.";
      setStatus(msg, "error");
    } finally {
      clearInterval(ticker);
      running = false;
      $("run").disabled = false;
    }
  });

  $("dl").addEventListener("click", () => {
    if (!lastAnswer) return;
    const blob = new Blob([JSON.stringify(lastAnswer, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `chefnmr2_${lastAnswer.input.formula}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
})();
