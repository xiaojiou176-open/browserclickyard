#!/usr/bin/env bash
set -euo pipefail

is_port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "( sport = :$port )" | grep -q ":$port"
    return $?
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -an 2>/dev/null | grep -E "LISTEN|LISTENING" | grep -q "[.:]${port}[[:space:]]"
    return $?
  fi
  python3 - "$port" <<'PY'
import socket
import sys

port = int(sys.argv[1])
for host, family in [("127.0.0.1", socket.AF_INET), ("::1", socket.AF_INET6)]:
    try:
        with socket.socket(family, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.2)
            if sock.connect_ex((host, port)) == 0:
                raise SystemExit(0)
    except OSError:
        continue
raise SystemExit(1)
PY
}

find_available_port() {
  local start_port="$1"
  local max_tries="${2:-30}"
  local port="$start_port"
  local tries=0
  while (( tries < max_tries )); do
    if ! is_port_in_use "$port"; then
      echo "$port"
      return 0
    fi
    port=$((port + 1))
    tries=$((tries + 1))
  done
  return 1
}

validate_port_number() {
  local port="$1"
  local var_name="$2"
  if [[ ! "$port" =~ ^[0-9]+$ ]]; then
    echo "error: $var_name must be an integer (got: $port)"
    return 1
  fi
}

extract_url_port() {
  local url="$1"
  python3 - "$url" <<'PY'
import sys
from urllib.parse import urlparse

parsed = urlparse(sys.argv[1])
if parsed.scheme not in {"http", "https"}:
    raise SystemExit(1)

if parsed.port is not None:
    print(parsed.port)
    raise SystemExit(0)

if parsed.scheme == "http":
    print(80)
    raise SystemExit(0)

if parsed.scheme == "https":
    print(443)
    raise SystemExit(0)

raise SystemExit(1)
PY
}
