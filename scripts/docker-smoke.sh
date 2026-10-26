#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
image="${ECS_DOCKER_IMAGE:-emulator-content-server:local}"
if [ "${ECS_DOCKER_SKIP_BUILD:-0}" != 1 ]; then
  docker build -f deploy/docker/Dockerfile -t "$image" .
fi
container="$(docker run -d --rm -p 127.0.0.1::8473 -e ECS_ALLOW_LAN=1 "$image")"
cleanup() {
  docker stop "$container" >/dev/null
}
trap cleanup EXIT
port="$(docker inspect --format '{{ (index (index .NetworkSettings.Ports "8473/tcp") 0).HostPort }}' "$container")"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    curl -fsS "http://127.0.0.1:$port/api/v1/capabilities" >/dev/null
    docker exec "$container" node --input-type=module -e '
      const base = "http://127.0.0.1:8473";
      const response = await fetch(`${base}/ui/`);
      if (!response.ok) throw new Error("Container interface is missing");
      const html = await response.text();
      const assets = [...html.matchAll(/(?:src|href)="([^" ]+\.(?:js|css))"/g)];
      if (assets.length < 2) throw new Error("Built interface assets are missing");
      for (const match of assets) {
        const asset = new URL(match[1], `${base}/ui/`);
        if (asset.origin !== base || !(await fetch(asset)).ok) throw new Error("Container asset is missing");
      }
    '
    echo "docker smoke test passed"
    exit 0
  fi
  sleep 1
done
echo "server did not become healthy" >&2
docker logs "$container" >&2
exit 1
