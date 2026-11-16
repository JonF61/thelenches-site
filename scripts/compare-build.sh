#!/usr/bin/env bash
# Compare two Eleventy builds (e.g. before and after moving files), ignoring only build
# timestamps (calendar DTSTAMP, photo-pages.json generated) and the page's template path (data-src).
# Usage: scripts/compare-build.sh <old _site> <new _site>
set -euo pipefail
norm() { sed -E -e 's/^DTSTAMP:[0-9TZ]+/DTSTAMP:x/' -e 's/"generated": "[^"]*"/"generated": "x"/' -e 's#data-src="\./(src|sites/[a-z]+)/#data-src="./SITE/#g' "$1"; }
fail=0
while IFS= read -r f; do
  rel=${f#"$1"/}
  if [ ! -f "$2/$rel" ]; then echo "missing in new: $rel"; fail=1; continue; fi
  if ! cmp -s <(norm "$1/$rel") <(norm "$2/$rel"); then echo "differs: $rel"; fail=1; fi
done < <(find "$1" -type f | sort)
while IFS= read -r f; do rel=${f#"$2"/}; [ -f "$1/$rel" ] || { echo "only in new: $rel"; fail=1; }; done < <(find "$2" -type f | sort)
[ $fail = 0 ] && echo "Builds match (apart from DTSTAMP and data-src)."
exit $fail
