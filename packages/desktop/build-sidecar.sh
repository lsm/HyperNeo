#!/bin/bash
exec bun "$(dirname "$0")/build-sidecar.ts" "$@"
