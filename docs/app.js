/* Page logic: fills the form, calls the public Space (chefnmr.js), draws the ranked structures with RDKit.js, and
 * offers ChemDraw/SDF downloads (cdxml.js + OpenChemLib) and an interactive 3D view (OpenChemLib + 3Dmol.js).
 * Response strings are only ever inserted with textContent; the one innerHTML-like insertion is RDKit's own SVG,
 * parsed as XML with scripts stripped. All libraries are vendored in docs/vendor and loaded on first use. */
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

  // ---- OpenChemLib (2D layout for ChemDraw export, 3D conformers) and 3Dmol.js, loaded on first use -----------
  let oclPromise = null, oclResourcesPromise = null, dmolPromise = null;
  function loadOCL() {
    if (!oclPromise) oclPromise = import("./vendor/openchemlib/openchemlib.js").catch((e) => { oclPromise = null; throw e; });
    return oclPromise;
  }
  async function loadOCLWithResources() { // the conformer generator needs OpenChemLib's torsion database
    const OCL = await loadOCL();
    if (!oclResourcesPromise) {
      oclResourcesPromise = OCL.Resources.registerFromUrl(new URL("vendor/openchemlib/resources.json", document.baseURI).href)
        .catch((e) => { oclResourcesPromise = null; throw e; });
    }
    await oclResourcesPromise;
    return OCL;
  }
  function load3Dmol() {
    if (!dmolPromise) {
      dmolPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "vendor/3dmol/3Dmol-min.js";
        s.onload = () => (window.$3Dmol ? resolve(window.$3Dmol) : reject(new Error("3Dmol.js did not initialise")));
        s.onerror = () => { dmolPromise = null; reject(new Error("3Dmol.js could not be loaded")); };
        document.head.appendChild(s);
      });
    }
    return dmolPromise;
  }

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---- status / results --------------------------------------------------------------------------------
  const statusEl = $("status");
  function setStatus(text, kind) {
    statusEl.hidden = !text;
    statusEl.textContent = text || "";
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  // The "running" panel: spinner, indeterminate bar and shimmering placeholder cards, so it is obvious the click worked.
  let runTimer = null;
  function setRunning(on, input) {
    $("run").classList.toggle("busy", on);
    $("run").disabled = on;
    $("run-label").textContent = on ? "Running…" : "Elucidate structure";
    document.querySelector(".out").setAttribute("aria-busy", String(on));
    clearInterval(runTimer);
    $("running").hidden = !on;
    if (!on) return;
    $("results").hidden = true;
    $("placeholder").hidden = true;
    setStatus("");
    const t0 = Date.now();
    const sub = () => { $("run-sub").textContent = `${input.formula} · ${input.n_samples} samples · ${Math.round((Date.now() - t0) / 1000)} s elapsed`; };
    sub();
    runTimer = setInterval(sub, 1000);
    const calm = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    $("running").scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "nearest" });
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
    $("dl-cdxml").hidden = $("dl-sdf").hidden = cands.length === 0;

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

      const btns = el("div", "btns");
      const copy = el("button", "ghost small", "Copy SMILES");
      copy.type = "button";
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(c.smiles); copy.textContent = "Copied"; } catch (_) { copy.textContent = "Copy failed"; }
        setTimeout(() => { copy.textContent = "Copy SMILES"; }, 1500);
      });
      const cd = el("button", "ghost small", "ChemDraw");
      cd.type = "button";
      cd.title = "Download this structure as a ChemDraw (.cdxml) file";
      cd.addEventListener("click", () => exportFile(cd, "cdxml", [i]));
      const td = el("button", "ghost small", "3D view");
      td.type = "button";
      td.setAttribute("aria-expanded", "false");
      td.addEventListener("click", () => toggle3D(li, c.smiles, td));
      btns.append(copy, cd, td);

      body.append(head, bar, smi, btns);
      li.append(pic, body);
      list.appendChild(li);
    });

    const imp = answer.implausible_candidates || [];
    $("implausible-box").hidden = imp.length === 0;
    const impList = $("implausible");
    impList.replaceChildren();
    imp.forEach((c) => impList.appendChild(el("li", "", `${c.smiles} — ${c.votes} sample${c.votes === 1 ? "" : "s"}`)));

    $("placeholder").hidden = true;
    $("results").hidden = false;
  }

  // ---- ChemDraw / SDF export -----------------------------------------------------------------------------
  async function exportFile(btn, kind, indices) {
    if (!lastAnswer || btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Preparing…";
    try {
      const OCL = await loadOCL();
      const { answer, input } = lastAnswer;
      const items = indices.map((i) => ({ i, c: answer.candidates[i], ...window.ChemDrawExport.fromOCL(OCL, answer.candidates[i].smiles) }));
      const pct = (c) => (c.vote_fraction * 100).toFixed(1);
      const stem = `chefnmr2_${input.formula}_` + (indices.length === 1 ? `candidate${indices[0] + 1}` : "candidates");
      if (kind === "cdxml") {
        const text = window.ChemDrawExport.toCDXML(items.map((x) => ({
          atoms: x.atoms, bonds: x.bonds, caption: `#${x.i + 1} · ${pct(x.c)}% · ${x.c.votes} samples`,
        })));
        download(`${stem}.cdxml`, text, "chemical/x-cdxml");
      } else {
        const text = window.ChemDrawExport.toSDF(items.map((x) => ({
          molfile: x.molfile,
          fields: { rank: x.i + 1, smiles: x.c.smiles, votes: x.c.votes, sampling_frequency: x.c.vote_fraction, formula: input.formula, source: "ChefNMR2 (public Space)" },
        })));
        download(`${stem}.sdf`, text, "chemical/x-mdl-sdfile");
      }
      btn.textContent = label;
    } catch (e) {
      console.error(e);
      btn.textContent = "Export failed";
      setTimeout(() => { btn.textContent = label; }, 2500);
    } finally {
      btn.disabled = false;
    }
  }

  // ---- interactive 3D view ---------------------------------------------------------------------------------
  // ChefNMR2 returns connectivity only (no coordinates), so the 3D model is built in the browser from the planar
  // SMILES with OpenChemLib's conformer generator. Conformation and stereochemistry are therefore arbitrary.
  const STYLES = {
    bs: { stick: { radius: 0.15 }, sphere: { scale: 0.25 } },
    stick: { stick: { radius: 0.2 } },
    sphere: { sphere: { scale: 1.0 } },
  };

  async function toggle3D(card, smiles, btn) {
    const open = card.querySelector(".viewer-wrap");
    if (open) {
      if (open._viewer) { try { open._viewer.spin(false); open._viewer.clear(); } catch (_) { /* already gone */ } }
      open.remove();
      btn.textContent = "3D view";
      btn.setAttribute("aria-expanded", "false");
      return;
    }
    const wrap = el("div", "viewer-wrap");
    const msg = el("div", "viewer-msg", "Building a 3D model in your browser…");
    wrap.appendChild(msg);
    card.appendChild(wrap);
    btn.textContent = "Hide 3D";
    btn.setAttribute("aria-expanded", "true");
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30))); // let the message paint first

    try {
      const [OCL, $3] = await Promise.all([loadOCLWithResources(), load3Dmol()]);
      let seed = 1;
      const conformer = () => {
        const mol = OCL.Molecule.fromSmiles(smiles);
        const conf = new OCL.ConformerGenerator(seed++).getOneConformerAsMolecule(mol);
        if (!conf) throw new Error("no 3D conformer could be generated for this structure");
        return conf.toMolfile();
      };
      let molfile = conformer();
      if (!wrap.isConnected) return; // closed while building

      msg.remove();
      const bar = el("div", "viewer-bar");
      const style = el("select"); style.setAttribute("aria-label", "Display style");
      [["bs", "Ball and stick"], ["stick", "Sticks"], ["sphere", "Space-filling"]].forEach(([v, t]) => {
        const o = el("option", "", t); o.value = v; style.appendChild(o);
      });
      const spin = el("button", "ghost small", "Spin"); spin.type = "button";
      const fresh = el("button", "ghost small", "New conformer"); fresh.type = "button";
      const reset = el("button", "ghost small", "Reset view"); reset.type = "button";
      bar.append(style, spin, fresh, reset);
      const box = el("div", "viewer");
      const note = el("p", "viewer-note",
        "Drag to rotate · scroll or pinch to zoom · right-drag (or two fingers) to move. This model is generated in your browser " +
        "from the planar structure; ChefNMR2 returns connectivity only, so the conformation and any stereochemistry shown are arbitrary.");
      wrap.append(bar, box, note);

      const viewer = $3.createViewer(box, { backgroundColor: "white" });
      wrap._viewer = viewer;
      const show = () => {
        viewer.removeAllModels();
        viewer.addModel(molfile, "mol");
        viewer.setStyle({}, STYLES[style.value]);
        viewer.zoomTo();
        viewer.render();
      };
      show();
      let spinning = false;
      spin.addEventListener("click", () => { spinning = !spinning; viewer.spin(spinning ? "y" : false, 1); spin.textContent = spinning ? "Stop" : "Spin"; });
      style.addEventListener("change", () => { viewer.setStyle({}, STYLES[style.value]); viewer.render(); });
      fresh.addEventListener("click", () => { try { molfile = conformer(); show(); } catch (e) { note.textContent = e.message; } });
      reset.addEventListener("click", () => { viewer.zoomTo(); viewer.render(); });
      if (window.ResizeObserver) new ResizeObserver(() => viewer.resize()).observe(box);
    } catch (e) {
      console.error(e);
      msg.textContent = `Could not build a 3D model: ${e.message}`;
    }
  }

  // ---- run ---------------------------------------------------------------------------------------------
  let running = false;
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
    setRunning(true, input);
    loadRDKit().catch(() => {}); // fetch the drawing library while the GPU works

    try {
      const answer = await window.ChefNMR.runSpace(SITE.spaceUrl, input);
      if (!answer || !Array.isArray(answer.candidates)) throw new Error("The Space returned an unexpected answer.");
      await render(answer, input, via, reportedFor(input));
    } catch (e) {
      let msg = e && e.message ? e.message : String(e);
      if (e && (e.name === "AbortError" || /timeout/i.test(msg))) msg = "The request timed out. Try fewer samples or try again in a minute.";
      else if (/failed to fetch|networkerror|load failed/i.test(msg)) msg = "Could not reach the public Space (it may be restarting or you may be offline). Try again in a minute.";
      else if (/runs limit|quota|zerogpu/i.test(msg)) msg = "The public Space's free GPU allowance for your network is used up for now (it is per visitor and resets daily; anonymous visitors get only a few runs, and a 1000-sample run uses most of one). Try fewer samples or try again later.";
      setStatus(msg, "error");
      $("placeholder").hidden = false;
    } finally {
      running = false;
      setRunning(false);
    }
  });

  $("dl-cdxml").addEventListener("click", (ev) => exportFile(ev.currentTarget, "cdxml", lastAnswer ? lastAnswer.answer.candidates.map((_, i) => i) : []));
  $("dl-sdf").addEventListener("click", (ev) => exportFile(ev.currentTarget, "sdf", lastAnswer ? lastAnswer.answer.candidates.map((_, i) => i) : []));

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
