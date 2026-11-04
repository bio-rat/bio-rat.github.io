"""Round-trip test of docs/cdxml.js: Python RDKit builds structure data, Node writes CDXML with the page's own
generator, RDKit's CDXML reader parses it back, and the structures must be identical (planar canonical SMILES).

    python tests/test_cdxml_roundtrip.py        # needs RDKit (2023.09+ for the CDXML reader) and node

This checks the file is well-formed CDXML that a ChemDraw-aware reader interprets as the same molecules. It cannot
prove that the ChemDraw application opens it; if it ever does not, the SDF download is the fallback.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from rdkit import Chem
from rdkit.Chem import rdDepictor

ROOT = Path(__file__).resolve().parents[1]
SMILES = {
    # reported structures of the page's examples (stereo removed: the model gives planar structures)
    "morphine": "CN1CCC23c4c5ccc(O)c4OC2C(O)C=CC3C1C5",
    "penicillin G": "CC1(C)SC2C(NC(=O)Cc3ccccc3)C(=O)N2C1C(=O)O",
    "artemisinin": "CC1CCC2C(C)C(=O)OC3OC4(C)CCC1C32OO4",
    "lysergic acid": "CN1CC(C(=O)O)C=C2c3cccc4[nH]cc(c34)CC21",
    "ingenol": "CC1CC2C(C)(C)C2(O)C(=O)C2(C)C(O)C=C(CO)CC2(O)C1=C",
    # charges, hydrogens on heteroatoms, and the other elements the model can emit
    "nitromethane": "C[N+](=O)[O-]",
    "methylammonium": "C[NH3+]",
    "acetate": "CC(=O)[O-]",
    "sulfonamide": "CS(=O)(=O)N",
    "methyl phosphate": "COP(=O)(O)O",
    "methylboronic acid": "CB(O)O",
    "tetramethylsilane": "C[Si](C)(C)C",
    "pyrrole": "c1cc[nH]c1",
    "N-methylpyridinium": "C[n+]1ccccc1",
    "halides": "FC(Cl)(Br)CI",
    "dimethyl selenide": "C[Se]C",
    "trimethylarsine": "C[As](C)C",
    "thiophene": "c1ccsc1",
    "benzene": "c1ccccc1",
    "ethanol": "CCO",
}


def structure(smiles, caption):
    mol = Chem.MolFromSmiles(smiles)
    expected = Chem.MolToSmiles(mol)
    rdDepictor.Compute2DCoords(mol)
    conf = mol.GetConformer()
    h = [a.GetTotalNumHs() for a in mol.GetAtoms()]
    Chem.Kekulize(mol, clearAromaticFlags=True)
    atoms = [
        {"symbol": a.GetSymbol(), "x": conf.GetAtomPosition(i).x, "y": conf.GetAtomPosition(i).y,
         "charge": a.GetFormalCharge(), "h": h[i]}
        for i, a in enumerate(mol.GetAtoms())
    ]
    bonds = [{"a": b.GetBeginAtomIdx(), "b": b.GetEndAtomIdx(), "order": int(b.GetBondTypeAsDouble())} for b in mol.GetBonds()]
    return {"atoms": atoms, "bonds": bonds, "caption": caption}, expected


def roundtrip(items):
    structs, expected = zip(*[structure(s, n) for n, s in items])
    with tempfile.TemporaryDirectory() as d:
        src, out = Path(d, "s.json"), Path(d, "o.cdxml")
        src.write_text(json.dumps(list(structs)))
        subprocess.run(["node", str(ROOT / "tests" / "cdxml_cli.cjs"), "cdxml", str(src), str(out)], check=True)
        text = out.read_text()
    mols = Chem.MolsFromCDXML(text)
    return text, [Chem.MolToSmiles(m) for m in mols], list(expected)


def sdf_roundtrip():
    """docs/cdxml.js toSDF: molfiles (including one with an all-blank 3-line header) plus data fields must read back
    through RDKit's SD reader with structures and fields intact."""
    import io

    items = list(SMILES.items())[:6]
    records = []
    for i, (name, smi) in enumerate(items):
        mol = Chem.MolFromSmiles(smi)
        rdDepictor.Compute2DCoords(mol)
        block = Chem.MolToMolBlock(mol)
        if i == 0:  # a header a global newline collapse would corrupt
            block = "\n\n\n" + block.split("\n", 3)[3]
        records.append({"molfile": block, "fields": {"rank": i + 1, "smiles": smi, "note": "two\nlines"}})
    with tempfile.TemporaryDirectory() as d:
        src, out = Path(d, "r.json"), Path(d, "o.sdf")
        src.write_text(json.dumps(records))
        subprocess.run(["node", str(ROOT / "tests" / "cdxml_cli.cjs"), "sdf", str(src), str(out)], check=True)
        text = out.read_text()
    got = list(Chem.ForwardSDMolSupplier(io.BytesIO(text.encode())))
    ok = len(got) == len(items) and all(m is not None for m in got)
    ok = ok and all(Chem.MolToSmiles(m) == Chem.MolToSmiles(Chem.MolFromSmiles(smi)) for m, (_, smi) in zip(got, items))
    ok = ok and [m.GetProp("rank") for m in got] == [str(i + 1) for i in range(len(items))]
    ok = ok and all(m.GetProp("note") == "two lines" for m in got) and text.count("$$$$") == len(items)
    print(("ok   " if ok else "FAIL ") + f"SDF: {len(got)} records read back by RDKit, structures and data fields intact")
    return 0 if ok else 1


def main():
    failures = sdf_roundtrip()
    # 1) each structure alone
    for name, smi in SMILES.items():
        _, got, exp = roundtrip([(name, smi)])
        ok = got == exp
        failures += not ok
        print(("ok   " if ok else "FAIL ") + f"{name:20s} {exp[0] if ok else (exp, got)}")
    # 2) all on one page, as the 'download all' button does
    text, got, exp = roundtrip(list(SMILES.items()))
    ok = got == exp
    failures += not ok
    print(("ok   " if ok else "FAIL ") + f"all {len(SMILES)} on one page: {len(got)} fragments parsed, order and structures preserved: {ok}")
    if not ok:
        for e, g in zip(exp, got):
            if e != g:
                print("   expected", e, "got", g)
    # 3) well-formed XML with the expected skeleton
    import xml.dom.minidom as md
    md.parseString(text.split("\n", 2)[2].replace('<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd" >', ""))
    assert text.startswith("<?xml") and "<CDXML " in text and text.rstrip().endswith("</CDXML>")
    import re
    ids = [int(m) for m in re.findall(r'<(?:page|fragment|n|b|t) id="(\d+)"', text)]
    font_ids = [int(m) for m in re.findall(r'<font id="(\d+)"', text)]
    assert len(ids) == len(set(ids)), "duplicate object ids"
    assert not set(ids) & set(font_ids), "an object id collides with a font id"
    print(f"ok   XML well-formed, {len(ids)} unique ids")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
