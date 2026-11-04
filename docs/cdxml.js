/* ChemDraw export: turns structures into CDXML (ChemDraw's native XML format) or an SDF.
 *
 * Pure functions, no DOM and no chemistry library: the caller supplies plain structure data
 *   { atoms: [{ symbol, x, y, charge, h }], bonds: [{ a, b, order }], caption }
 * (x/y in any 2D unit, y pointing up as in a molfile; h = total hydrogens on the atom; bond order 1-3, Kekule form).
 * app.js builds that data from OpenChemLib, which also supplies the 2D layout and hydrogen counts.
 *
 * Skeletal style, as ChemDraw draws: carbons are unlabeled vertices; every other atom (or any charged atom)
 * gets a formula-style label such as OH, NH2, N+, O-. Several structures are laid out on one page in a grid with a
 * caption under each.
 */
(function (root) {
  "use strict";

  const BOND_LENGTH = 14.4; // ChemDraw's ACS Document 1996 settings
  const GAP = 36;
  const PAGE_W = 540, PAGE_H = 720, MARGIN = 36;

  const SYMBOLS = ("H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr " +
    "Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os " +
    "Ir Pt Au Hg Tl Pb Bi Po At Rn").split(" ");
  const ATOMIC_NUMBER = Object.fromEntries(SYMBOLS.map((s, i) => [s, i + 1]));

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const num = (v) => (Math.round(v * 100) / 100).toString();

  function chargeText(q) {
    if (!q) return "";
    const mag = Math.abs(q);
    return (mag > 1 ? String(mag) : "") + (q > 0 ? "+" : "-");
  }

  function labelText(a) {
    const h = a.h || 0;
    return a.symbol + (h > 0 ? "H" + (h > 1 ? h : "") : "") + chargeText(a.charge || 0);
  }

  /** Scale a structure to ChemDraw's bond length, flip y (CDXML y points down) and move it to the origin. */
  function normalise(s) {
    const lens = s.bonds
      .map((b) => Math.hypot(s.atoms[b.a].x - s.atoms[b.b].x, s.atoms[b.a].y - s.atoms[b.b].y))
      .filter((l) => l > 1e-6)
      .sort((p, q) => p - q);
    const median = lens.length ? lens[Math.floor(lens.length / 2)] : 1;
    const k = BOND_LENGTH / median;
    const pts = s.atoms.map((a) => ({ x: a.x * k, y: -a.y * k }));
    const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
    return { pts: pts.map((p) => ({ x: p.x - minX, y: p.y - minY })), w: maxX - minX, h: maxY - minY };
  }

  /**
   * @param {Array} structures  [{atoms, bonds, caption}]
   * @returns {string} a CDXML document
   */
  function toCDXML(structures) {
    if (!structures.length) throw new Error("Nothing to export.");
    for (const s of structures) {
      if (!s.atoms.length) throw new Error("A structure has no atoms.");
      for (const a of s.atoms) if (!ATOMIC_NUMBER[a.symbol]) throw new Error(`Unknown element symbol: ${a.symbol}`);
    }
    const norm = structures.map(normalise);

    // Grid layout: as many columns as fit on a page, then rows.
    const cellW = Math.max(...norm.map((n) => n.w)) + GAP + 20;
    const cellH = Math.max(...norm.map((n) => n.h)) + GAP + 30; // room for the caption
    const cols = Math.max(1, Math.min(structures.length, Math.floor((PAGE_W - 2 * MARGIN) / cellW)));
    const rows = Math.ceil(structures.length / cols);
    const totalW = MARGIN * 2 + cols * cellW;
    const totalH = MARGIN * 2 + rows * cellH;
    const pagesW = Math.max(1, Math.ceil(totalW / PAGE_W)), pagesH = Math.max(1, Math.ceil(totalH / PAGE_H));

    let id = 100; // object ids start well above the font-table id (3), as ChemDraw numbers everything from one counter
    const nextId = () => ++id;
    const pageId = nextId();
    const out = [];

    structures.forEach((s, i) => {
      const n = norm[i];
      const ox = MARGIN + (i % cols) * cellW;
      const oy = MARGIN + Math.floor(i / cols) * cellH;
      const fragId = nextId();
      const atomIds = s.atoms.map(() => nextId());
      const body = [];
      s.atoms.forEach((a, j) => {
        const x = ox + n.pts[j].x, y = oy + n.pts[j].y;
        const labelled = a.symbol !== "C" || (a.charge || 0) !== 0;
        let attrs = `id="${atomIds[j]}" p="${num(x)} ${num(y)}"`;
        if (a.symbol !== "C") attrs += ` Element="${ATOMIC_NUMBER[a.symbol]}"`;
        if (a.charge) attrs += ` Charge="${a.charge}"`;
        if (labelled) {
          attrs += ` NumHydrogens="${a.h || 0}"`;
          const tid = nextId();
          // Label anchor: roughly centred on the atom for a 10 pt font.
          body.push(
            `<n ${attrs}><t id="${tid}" p="${num(x - 3.6)} ${num(y + 3.6)}" LabelJustification="Left" LabelAlignment="Left">` +
              `<s font="3" size="10" color="0" face="96">${esc(labelText(a))}</s></t></n>`
          );
        } else {
          body.push(`<n ${attrs}/>`);
        }
      });
      s.bonds.forEach((b) => {
        const order = b.order && b.order !== 1 ? ` Order="${b.order}"` : "";
        body.push(`<b id="${nextId()}" B="${atomIds[b.a]}" E="${atomIds[b.b]}"${order}/>`);
      });
      out.push(
        `<fragment id="${fragId}" BoundingBox="${num(ox)} ${num(oy)} ${num(ox + n.w)} ${num(oy + n.h)}">${body.join("")}</fragment>`
      );
      if (s.caption) {
        out.push(
          `<t id="${nextId()}" p="${num(ox)} ${num(oy + n.h + 24)}" Justification="Left" InterpretChemically="no">` +
            `<s font="3" size="10" color="0">${esc(s.caption)}</s></t>`
        );
      }
    });

    return (
      `<?xml version="1.0" encoding="UTF-8" ?>\n` +
      `<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd" >\n` +
      `<CDXML CreationProgram="ChefNMR2 demo (bio-rat.github.io)" BoundingBox="0 0 ${PAGE_W * pagesW} ${PAGE_H * pagesH}" ` +
      `LineWidth="0.6" BoldWidth="2" BondLength="${BOND_LENGTH}" BondSpacing="18" MarginWidth="1.6" HashSpacing="2.5" ` +
      `LabelFont="3" LabelSize="10" LabelFace="96" CaptionFont="3" CaptionSize="10" ` +
      `ShowTerminalCarbonLabels="no" ShowNonTerminalCarbonLabels="no" HideImplicitHydrogens="no" InterpretChemically="yes" ` +
      `color="0" bgcolor="1">\n` +
      `<colortable><color r="1" g="1" b="1"/><color r="0" g="0" b="0"/><color r="1" g="0" b="0"/><color r="1" g="1" b="0"/>` +
      `<color r="0" g="1" b="0"/><color r="0" g="1" b="1"/><color r="0" g="0" b="1"/><color r="1" g="0" b="1"/></colortable>\n` +
      `<fonttable><font id="3" charset="iso-8859-1" name="Arial"/></fonttable>\n` +
      `<page id="${pageId}" BoundingBox="0 0 ${PAGE_W * pagesW} ${PAGE_H * pagesH}" HeaderPosition="36" FooterPosition="36" ` +
      `PrintTrimMarks="yes" HeightPages="${pagesH}" WidthPages="${pagesW}">\n` +
      out.join("\n") +
      `\n</page>\n</CDXML>\n`
    );
  }

  /** SDF text from [{molfile, fields:{name: value}}] (molfiles from any toolkit; the title line may be blank). */
  function toSDF(records) {
    return records
      .map((r) => {
        const mol = r.molfile.replace(/\s+$/, ""); // ends with "M  END"; leading blank title lines are kept
        const fields = Object.entries(r.fields || {})
          .map(([k, v]) => `> <${k}>\n${String(v).replace(/\r?\n/g, " ")}\n\n`)
          .join("");
        return `${mol}\n${fields}$$$$\n`;
      })
      .join("");
  }

  /**
   * Structure data from a SMILES, using an OpenChemLib namespace (OCL): 2D layout, Kekule bond orders, charges and
   * hydrogen counts, plus the 2D molfile (for SDF). OCL invents the 2D coordinates when it reads the SMILES.
   */
  function fromOCL(OCL, smiles) {
    const m = OCL.Molecule.fromSmiles(smiles);
    m.ensureHelperArrays(15);
    const atoms = [], bonds = [];
    for (let i = 0; i < m.getAllAtoms(); i++) {
      atoms.push({ symbol: m.getAtomLabel(i), x: m.getAtomX(i), y: m.getAtomY(i), charge: m.getAtomCharge(i), h: m.getAllHydrogens(i) });
    }
    for (let b = 0; b < m.getAllBonds(); b++) {
      const order = m.getBondOrder(b);
      bonds.push({ a: m.getBondAtom(0, b), b: m.getBondAtom(1, b), order: order >= 1 && order <= 3 ? order : 1 });
    }
    return { atoms, bonds, molfile: m.toMolfile() };
  }

  const api = { toCDXML, toSDF, labelText, fromOCL };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ChemDrawExport = api;
})(typeof window !== "undefined" ? window : globalThis);
