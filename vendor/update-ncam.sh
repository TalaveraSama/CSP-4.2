#!/usr/bin/env bash
# Refresh vendor/ncam from upstream (https://github.com/fairbird/NCam).
#
#   bash vendor/update-ncam.sh              # latest master
#   bash vendor/update-ncam.sh <commit|tag> # a specific revision
set -euo pipefail

REPO="${NCAM_REPO:-https://github.com/fairbird/NCam.git}"
REF="${1:-master}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TMP="$(mktemp -d /tmp/ncam-update.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

echo "==> cloning $REPO ($REF)"
if [ "$REF" = master ] || [ "$REF" = main ]; then
  git clone --depth 1 --branch "$REF" "$REPO" "$TMP/src" >/dev/null
else
  git clone "$REPO" "$TMP/src" >/dev/null
  git -C "$TMP/src" checkout --quiet "$REF"
fi

SHA="$(git -C "$TMP/src" rev-parse HEAD)"
DATE="$(git -C "$TMP/src" log -1 --format=%cI)"
rm -rf "$TMP/src/.git"

echo "==> replacing vendor/ncam with $SHA"
rm -rf "$HERE/ncam"
cp -a "$TMP/src" "$HERE/ncam"

# Keep the provenance table in vendor/README.md in sync.
python3 - "$HERE/README.md" "$SHA" "$DATE" <<'PY'
import re, sys
path, sha, date = sys.argv[1:4]
text = open(path).read()
text = re.sub(r"(\| Commit \| `)[0-9a-f]+(` \|)", rf"\g<1>{sha}\g<2>", text)
text = re.sub(r"(\| Date \| )[^|]+(\|)", rf"\g<1>{date} \g<2>", text)
open(path, "w").write(text)
PY

echo
echo "vendor/ncam updated to $SHA ($DATE)"
echo "Review with: git -C \"$(git -C "$HERE" rev-parse --show-toplevel)\" status"
