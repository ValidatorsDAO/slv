#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="slv-systemd"
CONTAINER_NAME="slv-systemd"

if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
  docker rm -f "${CONTAINER_NAME}"
fi

if docker images --format '{{.Repository}}:{{.Tag}}' | grep -qx "${IMAGE_NAME}:latest"; then
  docker rmi -f "${IMAGE_NAME}:latest"
fi
