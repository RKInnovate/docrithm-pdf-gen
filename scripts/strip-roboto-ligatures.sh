#!/usr/bin/env bash
# ============================================================================
# strip-roboto-ligatures.sh — vendor a clean-text-layer Roboto family
# ----------------------------------------------------------------------------
# pdfmake's bundled Roboto carries a GSUB `liga` table. pdfmake renders the
# fi/fl/ff ligatures correctly on the page but writes a broken ToUnicode map
# for the ligature glyphs, so the PDF *text layer* reads "Ofce"/"Refned".
# Removing the GSUB table makes every glyph map 1:1 to its codepoint, so text
# extraction (copy-paste, pdftotext, LLMs reading the text layer) matches the
# page. Run from the repo root; commits the result under assets/fonts/.
#
#   ./scripts/strip-roboto-ligatures.sh
#
# Requires: node (to decode pdfmake's base64 VFS) + uv (to run fonttools).
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Decoding pdfmake's bundled Roboto TTFs into assets/fonts/"
node <<'NODE'
const fs = require('fs'); const path = require('path')
const vfs = require('pdfmake/build/vfs_fonts.js')
const map = vfs?.pdfMake?.vfs ?? vfs
for (const f of ['Roboto-Regular.ttf','Roboto-Medium.ttf','Roboto-Italic.ttf','Roboto-MediumItalic.ttf']) {
  fs.writeFileSync(path.join('assets','fonts',f), Buffer.from(map[f],'base64'))
  console.log('  decoded', f)
}
NODE

echo "==> Stripping GSUB (ligature) table with fontTools"
uv run --quiet --with fonttools python - <<'PY'
from fontTools.ttLib import TTFont
import os
for name in ("Roboto-Regular.ttf","Roboto-Medium.ttf","Roboto-Italic.ttf","Roboto-MediumItalic.ttf"):
    p = os.path.join("assets","fonts",name)
    f = TTFont(p)
    if "GSUB" in f:
        del f["GSUB"]
    f.save(p)
    print("  stripped", name)
PY

echo "==> Done. Vendored ligature-free Roboto under assets/fonts/"
