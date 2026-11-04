// CLI used by test_cdxml_roundtrip.py: node tests/cdxml_cli.cjs <structures.json> <out.cdxml>
const fs = require("fs"), path = require("path");
const { toCDXML } = require(path.join(__dirname, "..", "docs", "cdxml.js"));
fs.writeFileSync(process.argv[3], toCDXML(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))));
