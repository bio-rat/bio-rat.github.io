// CLI used by test_cdxml_roundtrip.py:
//   node tests/cdxml_cli.cjs cdxml <structures.json> <out.cdxml>
//   node tests/cdxml_cli.cjs sdf   <records.json>    <out.sdf>
const fs = require("fs"), path = require("path");
const { toCDXML, toSDF } = require(path.join(__dirname, "..", "docs", "cdxml.js"));
const [mode, input, output] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(input, "utf8"));
fs.writeFileSync(output, mode === "sdf" ? toSDF(data) : toCDXML(data));
