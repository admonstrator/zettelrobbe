#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DOCKER_BIN="${DOCKER_BIN:-docker}"
IMAGE_REPO="${IMAGE_REPO:-${LOCAL_NAMESPACE:-docker.io/library/zettelrobbe}}"
FORCE_REBUILD="${FORCE_REBUILD:-false}"

BASE_IMAGE="${BASE_IMAGE:-${IMAGE_REPO}:latest-base}"
APP_IMAGE="${APP_IMAGE:-${IMAGE_REPO}:latest}"

if command -v git >/dev/null 2>&1; then
  COMMIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
else
  COMMIT_SHA="unknown"
fi

BUILD_FLAGS=()

refresh_build_flags() {
  BUILD_FLAGS=()
  if [[ "$FORCE_REBUILD" == "true" ]]; then
    BUILD_FLAGS+=(--no-cache --pull)
  fi
}

toggle_force_rebuild() {
  if [[ "$FORCE_REBUILD" == "true" ]]; then
    FORCE_REBUILD="false"
  else
    FORCE_REBUILD="true"
  fi
  refresh_build_flags
}

print_header() {
  echo
  echo "=============================================="
  echo " zettelrobbe image builder"
  echo "=============================================="
  echo " Base : ${BASE_IMAGE}"
  echo " App  : ${APP_IMAGE}"
  echo " Commit   : ${COMMIT_SHA}"
  echo " Cache    : $([[ "$FORCE_REBUILD" == "true" ]] && echo "force rebuild (--no-cache --pull)" || echo "normal build")"
  echo
}

ensure_docker() {
  if ! command -v "$DOCKER_BIN" >/dev/null 2>&1; then
    echo "Error: Docker CLI not found (${DOCKER_BIN})." >&2
    exit 1
  fi

  if ! "$DOCKER_BIN" info >/dev/null 2>&1; then
    echo "Error: Docker daemon is not reachable. Start Docker first." >&2
    exit 1
  fi
}

build_base() {
  echo -e "\n[1/1] Building base image: ${BASE_IMAGE}"
  "$DOCKER_BIN" build \
    "${BUILD_FLAGS[@]+"${BUILD_FLAGS[@]}"}" \
    -f Dockerfile.base \
    -t "${BASE_IMAGE}" \
    .
  echo "Done: ${BASE_IMAGE}"
}

build_app() {
  echo -e "\n[1/1] Building app image: ${APP_IMAGE}"
  "$DOCKER_BIN" build \
    "${BUILD_FLAGS[@]+"${BUILD_FLAGS[@]}"}" \
    --build-arg BASE_IMAGE="${BASE_IMAGE}" \
    --build-arg PAPERLESS_AI_COMMIT_SHA="${COMMIT_SHA}" \
    -f Dockerfile \
    -t "${APP_IMAGE}" \
    .
  
  # Add aliases for backward compatibility
  "$DOCKER_BIN" tag "${APP_IMAGE}" "${IMAGE_REPO}:latest-lite"
  "$DOCKER_BIN" tag "${APP_IMAGE}" "${IMAGE_REPO}:latest-full"
  
  echo "Done: ${APP_IMAGE} (Aliased to latest-lite and latest-full)"
}

show_compose_usage() {
  cat <<EOF

How to use the built image in docker-compose.yml:

services:
  zettelrobbe:
    image: ${APP_IMAGE}
    pull_policy: never
    container_name: zettelrobbe
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - paperless-ai-next_data:/app/data

Then start/recreate:
  docker compose up -d --force-recreate

Tip:
- Keep pull_policy: never for local images.
- If your service still has a build: section, remove or comment it out when using image:.
EOF
}

run_action() {
  local action="${1:-menu}"

  case "$action" in
    base)
      build_base
      ;;
    app)
      build_app
      show_compose_usage
      ;;
    all)
      build_base
      build_app
      show_compose_usage
      ;;
    menu)
      while true; do
        print_header
        echo "Select build target:"
        echo "  0) Toggle force rebuild without cache"
        echo "  1) Build base image"
        echo "  2) Build app image"
        echo "  3) Build everything (base + app)"
        echo "  4) Show docker-compose usage"
        echo "  5) Exit"
        read -r -p "Choice [0-5]: " choice

        case "$choice" in
          0) toggle_force_rebuild ;;
          1) build_base ;;
          2) build_app; show_compose_usage ;;
          3) build_base; build_app; show_compose_usage ;;
          4) show_compose_usage ;;
          5) echo "Bye."; break ;;
          *) echo "Invalid choice." ;;
        esac

        echo
        read -r -p "Press Enter to continue..." _
      done
      ;;
    *)
      cat <<EOF
Unknown argument: ${action}

Usage:
  ./build.sh               # interactive menu
  ./build.sh menu
  ./build.sh --no-cache menu
  ./build.sh base|app|all

Optional overrides:
  FORCE_REBUILD=true ./build.sh all
  IMAGE_REPO=docker.io/library/myrepo ./build.sh all
  LOCAL_NAMESPACE=myrepo ./build.sh all
  BASE_IMAGE=my/base:latest APP_IMAGE=my/app:latest ./build.sh all
EOF
      exit 1
      ;;
  esac
}

ensure_docker

ACTION="menu"
for arg in "$@"; do
  case "$arg" in
    --no-cache)
      FORCE_REBUILD="true"
      ;;
    --cache)
      FORCE_REBUILD="false"
      ;;
    menu|base|app|all)
      ACTION="$arg"
      ;;
    *)
      run_action "$arg"
      exit 1
      ;;
  esac
done

refresh_build_flags
run_action "$ACTION"
