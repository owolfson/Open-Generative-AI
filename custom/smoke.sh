#!/usr/bin/env bash
# Route smoke test. Usage: custom/smoke.sh http://host:port
# Add a line per custom route: a route that stops answering after an upstream merge fails the sync.
set -u
BASE=${1:?usage: smoke.sh http://host:port}
fail=0
check() {
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$BASE$1")
  if [ "$got" = "$2" ]; then echo "ok   $1 $got"; else echo "FAIL $1 got=$got want=$2"; fail=1; fi
}
check /studio 200
check /zh/studio 200
check /agents/create 200
check /workflow/smoke 200
check / 307
exit $fail
