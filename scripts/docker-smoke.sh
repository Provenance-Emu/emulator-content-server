#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker build -f deploy/docker/Dockerfile -t emulator-content-server:local .
container="$(docker run -d --rm -p 127.0.0.1:8473:8473 -e ECS_ALLOW_LAN=1 emulator-content-server:local)"
cleanup() {
  docker stop "$container" >/dev/null
}
trap cleanup EXIT
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:8473/health >/dev/null; then
    curl -fsS http://127.0.0.1:8473/api/v1/capabilities >/dev/null
    echo "docker smoke test passed"
    exit 0
  fi
  sleep 1
done
echo "server did not become healthy" >&2
docker logs "$container" >&2
exit 1
