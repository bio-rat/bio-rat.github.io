# Portfolio page + ChefNMR2 interface

A static GitHub Pages portfolio with a live interface to
[ChefNMR2](https://github.com/ml-struct-bio/chefnmr2), which proposes a small molecule's planar structure from its
¹H/¹³C NMR peak lists and molecular formula.

## How it works

GitHub cannot run the model: **Pages** serves static files only, and GitHub's GPU runners are paid "larger runners" for
Actions jobs (Team/Enterprise only), not for serving a site. So the page is static and the GPU work happens on the
**public ChefNMR2 Space** that the model's authors host on Hugging Face (ZeroGPU):

```
browser ── https://bio-rat.github.io (docs/) ──► POST/GET  https://ziyux123-chefnmr2.hf.space/gradio_api/call/elucidate_structure
                                                 ◄ ranked candidate SMILES (JSON)
        draws 2D structures with RDKit.js; builds ChemDraw/SDF files and the 3D view with OpenChemLib + 3Dmol.js
```

### Downloads and the 3D view

- **ChemDraw (.cdxml)** for one candidate or all of them on one page (with rank, sampling frequency and sample count under each), and an **SDF**
  with the same data. The CDXML is written by `docs/cdxml.js`; `tests/test_cdxml_roundtrip.py` reads 20 test structures (charges,
  heteroatoms, aromatic rings, the five example molecules) back through RDKit's CDXML reader and checks they are identical. That is
  not the same as opening the file in the ChemDraw application, which has not been tried: if ChemDraw ever objects, use the SDF.
- **3D view** (per candidate): drag to rotate, scroll to zoom, plus spin, style and new-conformer controls. **The API returns no 3D
  coordinates** (only SMILES, votes and counts), so the model is generated in the browser from the planar SMILES with OpenChemLib's
  conformer generator. Conformation and stereochemistry in it are arbitrary and are not the model's own sampled coordinates.

The Space allows cross-origin calls from any site (checked with a preflight from a `github.io` origin).

## Limits to know about

- **Quota.** The Space runs on shared ZeroGPU, which gives each visitor a small daily GPU allowance. In testing from one
  network, the 4th default (100-sample) run in a short period was refused with *"You have exceeded your ZeroGPU runs
  limit. Authenticate with a Hugging Face token for more quota."* Anonymous visitors should expect only a few runs a day.
  The page shows a plain message when this happens.
- **Dependence.** The Space belongs to the authors; if they change its API or take it down, the demo stops until
  `docs/chefnmr.js` is adjusted. The model weights (11.5 GB) and code are public, so a self-hosted GPU endpoint is the
  fallback (not included here).
- **Privacy.** Input goes to Hugging Face. The page says so; don't submit unpublished or confidential spectra.
- Predictions are hypotheses: check the proposed structure against the spectra. The *sampling frequency* is the model's
  confidence. The page defaults to 1000 samples, the count the authors suggest when the top structure is below 97%; a
  1000-sample run uses much more of the Space's per-visitor GPU allowance than a 100-sample run (the Space's own code reserves
  about 98 s of it versus about 39 s), so anonymous visitors may get only a run or two a day.
- ChefNMR2's checkpoints are CDLA-Sharing-1.0 and were trained on data that include CC BY-NC 4.0 sources: check those
  terms before any commercial use. See `THIRD_PARTY.md`.

## Files

```
docs/                    the GitHub Pages site (no build step)
  index.html style.css app.js   page, styling, UI logic
  chefnmr.js                    Space client (Gradio HTTP API), no DOM, unit-tested
  cdxml.js                      ChemDraw (.cdxml) and SDF writers, no DOM, round-trip tested
  site.config.js                ← the file you edit: your name, tagline, links
  examples.js                   one-click example molecules (with reported structures)
  vendor/rdkit/                 RDKit.js (BSD-3): 2D drawings and the reported-structure match
  vendor/openchemlib/           OpenChemLib (BSD-3): 2D layout for ChemDraw files, 3D conformers (loaded on first use)
  vendor/3dmol/                 3Dmol.js (BSD-3): the interactive 3D viewer (loaded on first use)
tests/test_client.cjs           Node tests of docs/chefnmr.js (add --live for one real call to the Space)
tests/test_cdxml_roundtrip.py   writes CDXML with docs/cdxml.js and reads it back with RDKit (needs RDKit 2023.09+ and node)
```

## Publish

1. Create a **public** repo named `bio-rat.github.io` (a user-site repo, served at `https://bio-rat.github.io/`) and push
   this folder.
2. Settings → Pages → *Deploy from a branch* → `main` / `/docs`.
3. Edit `docs/site.config.js` (name, tagline, intro, links).

## Tests

```bash
node tests/test_client.cjs           # client logic with a mocked network
node tests/test_client.cjs --live    # + one real call to the Space (skipped if its quota is used up)
python tests/test_cdxml_roundtrip.py # ChemDraw writer: round trip through RDKit's CDXML reader
```

This folder has no licence file; add one (e.g. MIT) if you want others to reuse the page.
