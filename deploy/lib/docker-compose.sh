#!/usr/bin/env bash
# Source from deploy scripts: source "$(dirname "$0")/lib/docker-compose.sh"

qtask_compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "Error: Docker Compose not found. Install docker-compose-v2 or docker-compose." >&2
    return 1
  fi
}

qtask_compose_project() {
  qtask_compose -p qtask-ollama "$@"
}

# Prior installs used other compose project names but the same container_name values.
qtask_remove_legacy_jetson_containers() {
  local c
  for c in qtask-ollama qtask-ollama-docker-proxy; do
    if docker ps -aq -f "name=^/${c}$" 2>/dev/null | grep -q .; then
      echo "Removing legacy container ${c} (from a prior compose project)"
      docker rm -f "${c}"
    fi
  done
}

# First deploy from ~ used volume deploy_qtask_ollama_data; standardize on qtask_ollama_data.
qtask_migrate_jetson_ollama_volume() {
  if docker volume inspect qtask_ollama_data >/dev/null 2>&1; then
    return 0
  fi
  if docker volume inspect deploy_qtask_ollama_data >/dev/null 2>&1; then
    echo "Migrating Ollama models volume deploy_qtask_ollama_data -> qtask_ollama_data"
    docker volume create qtask_ollama_data
    docker run --rm \
      -v deploy_qtask_ollama_data:/from:ro \
      -v qtask_ollama_data:/to \
      alpine cp -a /from/. /to/
  fi
}
