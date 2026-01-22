#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="slv-systemd"
CONTAINER_NAME="slv-systemd"
DOCKERFILE_PATH="docker/systemd/Dockerfile"

docker build -f "${DOCKERFILE_PATH}" -t "${IMAGE_NAME}:latest" .

if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
  docker start "${CONTAINER_NAME}"
else
  docker run \
    --name "${CONTAINER_NAME}" \
    --privileged \
    --cgroupns=host \
    -e CI= \
    -e SLV_SKIP_SYSTEMD= \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    -v "$(pwd)":/workspace \
    -w /workspace \
    -d \
    "${IMAGE_NAME}:latest"
fi

docker exec "${CONTAINER_NAME}" /bin/bash -lc "systemctl is-system-running --wait || true"
docker exec "${CONTAINER_NAME}" /bin/bash -lc "loginctl enable-linger root || true"
docker exec "${CONTAINER_NAME}" /bin/bash -lc "loginctl enable-linger slv || true"

echo "Container ready: ${CONTAINER_NAME}"
echo "Enter: docker exec -it ${CONTAINER_NAME} bash"
