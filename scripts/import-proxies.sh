#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 /path/to/webshare-proxies.txt [secrets/gmaps-proxies.txt]" >&2
  exit 1
fi

source_file="$1"
destination="${2:-secrets/gmaps-proxies.txt}"
[ -f "$source_file" ] || { echo "Proxy source file not found" >&2; exit 1; }
mkdir -p "$(dirname "$destination")"

python3 - "$source_file" "$destination" <<'PY'
from pathlib import Path
from urllib.parse import quote
import re
import sys

source, destination = map(Path, sys.argv[1:])
normalized = []
for raw in source.read_text(encoding="utf-8-sig").splitlines():
    value = raw.strip()
    if not value or value.startswith("#"):
        continue
    if re.match(r"^(?:https?|socks5h?)://", value, re.I):
        normalized.append(value)
        continue
    match = re.match(r"^([^:\s]+):(\d+):([^:\s]+):(.+)$", value)
    if not match:
        raise SystemExit("Unrecognized proxy format; expected URL or host:port:user:password")
    host, port, user, password = match.groups()
    normalized.append(f"http://{quote(user, safe='')}:{quote(password, safe='')}@{host}:{port}")

if not normalized:
    raise SystemExit("No proxies found")
destination.write_text("\n".join(normalized) + "\n", encoding="utf-8")
destination.chmod(0o600)
print(f"Imported {len(normalized)} proxies into {destination} (credentials hidden).")
PY
