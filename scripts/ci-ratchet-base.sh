#!/usr/bin/env bash
set -eu
case "$GITHUB_EVENT_NAME:$GITHUB_REF" in
  push:refs/heads/dev) printf '%s\n' "$GITHUB_EVENT_BEFORE" ;;
  push:refs/tags/*) printf '%s^1\n' "$GITHUB_SHA" ;;
  *) printf '%s\n' 'origin/dev' ;;
esac
