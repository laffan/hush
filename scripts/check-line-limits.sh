#!/usr/bin/env bash
# Enforce the 700-line cap on JS / TS / Rust source files.
#
# Honors `.line-limit-exceptions` at the repo root. Each non-comment line
# is a path (everything before the first ` #` is the path).
#
# Exits 0 when all files comply; exits 1 with a list of violators and
# their line counts when they don't.
set -euo pipefail

LIMIT=700
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

EXCEPTIONS_FILE=".line-limit-exceptions"

# Build the exception set
exceptions=()
if [[ -f "$EXCEPTIONS_FILE" ]]; then
  while IFS= read -r raw; do
    # Strip leading whitespace
    line="${raw#"${raw%%[![:space:]]*}"}"
    # Skip blanks and comments
    [[ -z "$line" || "${line:0:1}" == "#" ]] && continue
    # Strip trailing comment (everything after first whitespace+#)
    path="${line%%[[:space:]]#*}"
    # Strip trailing whitespace
    path="${path%"${path##*[![:space:]]}"}"
    [[ -n "$path" ]] && exceptions+=("$path")
  done < "$EXCEPTIONS_FILE"
fi

is_excepted() {
  local target="$1"
  for e in "${exceptions[@]:-}"; do
    [[ "$target" == "$e" ]] && return 0
  done
  return 1
}

# Find candidate files. Use `find -print0` so paths with spaces survive.
violators=()
while IFS= read -r -d '' file; do
  # Strip ./ prefix that find adds
  rel="${file#./}"
  is_excepted "$rel" && continue
  count="$(wc -l < "$file" | tr -d ' ')"
  if (( count > LIMIT )); then
    violators+=("$count $rel")
  fi
done < <(
  find src src-tauri/src \
    \( -name '*.js' -o -name '*.ts' -o -name '*.rs' \) \
    -type f \
    ! -path '*/node_modules/*' \
    ! -path '*/dist/*' \
    ! -path '*/target/*' \
    ! -path '*/gen/*' \
    -print0
)

if (( ${#violators[@]} == 0 )); then
  echo "All files within the ${LIMIT}-line limit."
  exit 0
fi

echo "Files exceeding ${LIMIT} lines (add to ${EXCEPTIONS_FILE} only with a documented reason):"
printf '  %s\n' "${violators[@]}" | sort -rn
exit 1
