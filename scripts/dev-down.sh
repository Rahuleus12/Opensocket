#!/usr/bin/env bash
# Stop the OpenSocket dev stack by listening port (Linux/macOS counterpart
# to dev-down.ps1; needs fuser from psmisc).
set -uo pipefail
for port in 8080 8081 8082 8097 8098; do
  fuser -k "${port}/tcp" 2> /dev/null
done
echo "stopped"
