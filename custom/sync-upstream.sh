#!/usr/bin/env bash
# Pull upstream (Anil-matcha) into our 'owen' branch, build, smoke-test, optionally deploy.
#
#   custom/sync-upstream.sh --check    merge + build + smoke on a scratch container; deploy nothing
#   custom/sync-upstream.sh --deploy   same, then swap the live container (auto-rollback if it fails)
#   add --force to rebuild even when upstream has nothing new
#   add --push  to push main + owen to the fork after a green run
#
# 'owen' only advances after a green build + smoke, so a bad upstream commit never lands on it.
# Every run records its outcome in $OGAI_DATA/sync.state.json (heartbeat) - a silent no-op and a
# silently broken cron look identical without it. Alerts only on conflict / failure / deploy.
set -uo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
DATA=${OGAI_DATA:-/mnt/user/appdata/open-generative-ai}
MODE=--check; FORCE=0; PUSH=0
for a in "$@"; do case $a in
  --check|--deploy) MODE=$a ;; --force) FORCE=1 ;; --push) PUSH=1 ;;
  *) echo "unknown arg $a" >&2; exit 2 ;; esac; done

mkdir -p "$DATA"
exec 9>/tmp/ogai-sync.lock; flock -n 9 || { echo "another sync is running"; exit 0; }
exec > >(tee -a "$DATA/sync.log") 2>&1
cd "$REPO"
say() { echo "[$(date '+%F %T')] $*"; }

# Alerts: set OGAI_ALERT_URL to a POST /alert endpoint taking {"text","source"} (no URL = no alerts).
# On Owen's box that is the Hermes bot, whose allowlist matches the substring "hermes"; every alert is
# voiced there, so keep them short. Host-specific values live in the cron wrapper, not in this repo.
tg() {
  [ -n "${OGAI_ALERT_URL:-}" ] || return 0
  curl -s -m 20 -X POST "$OGAI_ALERT_URL" -H 'Content-Type: application/json' \
    -d "{\"text\":\"Open Generative AI sync: $1\",\"source\":\"hermes-ogai-sync\"}" >/dev/null 2>&1 || true
}

cleanup() {
  docker rm -f ogai-smoke >/dev/null 2>&1 || true
  if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = owen-sync ]; then
    git merge --abort >/dev/null 2>&1 || true
    git checkout -q owen 2>/dev/null || true
  fi
  git branch -D owen-sync >/dev/null 2>&1 || true
}

finish() {  # finish <result> <message> <exit-code>
  say "RESULT $1: $2"
  printf '{"ts":"%s","mode":"%s","result":"%s","message":"%s","upstream":"%s","owen":"%s"}\n' \
    "$(date -Is)" "$MODE" "$1" "$(echo "$2" | tr '"\\' "''")" \
    "$(git rev-parse --short upstream/main 2>/dev/null)" "$(git rev-parse --short owen 2>/dev/null)" \
    > "$DATA/sync.state.json"
  exit "${3:-0}"
}
trap 'cleanup' EXIT
fail() { tg "$1"; finish "$2" "$1" 1; }

say "sync start mode=$MODE force=$FORCE"
[ -z "$(git status --porcelain)" ] || finish blocked "working tree dirty - commit or stash first" 1
git checkout -q owen || finish error "cannot checkout owen" 1
git fetch upstream --prune -q || fail "fetch from upstream failed" error

git checkout -q main && git merge --ff-only -q upstream/main || { git checkout -q owen; fail "main is not a fast-forward of upstream" error; }
git checkout -q owen

if git merge-base --is-ancestor main owen && [ "$FORCE" = 0 ]; then
  finish noop "already contains upstream $(git rev-parse --short main)" 0
fi

# Merge on a scratch branch so a conflict or failed build leaves 'owen' untouched.
git checkout -q -B owen-sync owen
if ! git merge --no-edit -q main; then
  # rerere may have auto-resolved every hunk; then only the commit is missing.
  if [ -z "$(git diff --name-only --diff-filter=U)" ]; then
    git commit --no-edit -q
  else
    files=$(git diff --name-only --diff-filter=U | tr '\n' ' ')
    git merge --abort; git checkout -q owen
    fail "merge conflict in: $files" conflict
  fi
fi

say "building candidate"
./custom/build.sh open-generative-ai:candidate || fail "image build failed on merged upstream" build-failed

say "smoke-testing candidate on scratch container"
docker rm -f ogai-smoke >/dev/null 2>&1 || true
docker run -d --name ogai-smoke -p 3099:3000 open-generative-ai:candidate >/dev/null || fail "scratch container failed to start" smoke-failed
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' ogai-smoke 2>/dev/null)" = healthy ] && break; sleep 2
done
./custom/smoke.sh http://127.0.0.1:3099 || fail "smoke test failed on candidate" smoke-failed
docker rm -f ogai-smoke >/dev/null 2>&1

if [ "$MODE" = --deploy ]; then
  say "deploying"
  ./custom/deploy.sh open-generative-ai:candidate || fail "deploy failed - rolled back to previous image" deploy-failed
  if ! ./custom/smoke.sh "http://127.0.0.1:${OGAI_PORT:-3002}"; then
    ./custom/deploy.sh open-generative-ai:prev || true
    fail "live smoke failed after deploy - rolled back" deploy-failed
  fi
fi

git checkout -q owen && git merge --ff-only -q owen-sync && git branch -D owen-sync >/dev/null

if [ "$PUSH" = 1 ]; then
  say "pushing to fork"
  # OGAI_GH_TOKEN_CMD prints a GitHub token (on Owen's box: docker exec agent-reach gh auth token).
  # It goes to git via env so it never lands in .git/config.
  TOKEN=$(eval "${OGAI_GH_TOKEN_CMD:-gh auth token}" 2>/dev/null)
  if [ -n "$TOKEN" ]; then
    export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader
    GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"; export GIT_CONFIG_VALUE_0
    git push -q origin main owen || say "push failed (non-fatal)"
  else say "no GitHub token available - skipped push"; fi
fi

[ "$MODE" = --deploy ] && tg "deployed upstream $(git rev-parse --short main) merged, healthy."
finish ok "$MODE ok: upstream $(git rev-parse --short main) merged, built, smoke passed" 0
