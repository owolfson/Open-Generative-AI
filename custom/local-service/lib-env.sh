#!/usr/bin/env bash
# Sourced by deploy.sh / build-sdcpp.sh. Host-specific settings (GPU uuids, arbiter url, builder image) live OUTSIDE the repo
# in <data dir>/deploy.env as KEY=VALUE lines; variables already set in the real environment win over the file.
load_host_env() {
  local file=$1 key value
  [ -f "$file" ] || return 0
  while IFS='=' read -r key value; do
    case "$key" in ''|\#*) continue ;; esac
    [ -z "${!key+x}" ] && export "$key=$value"
  done < "$file"
  return 0
}
