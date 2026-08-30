#!/usr/bin/env bash
# Warm agent + embedding models after Ollama starts on Jetson.
# Source from deploy/start-ollama-jetson.sh or deploy-jetson-ollama.sh.

qtask_wait_jetson_ollama_api() {
  local bind_address="${1:?bind address required}"
  local attempts="${2:-30}"

  for _ in $(seq 1 "${attempts}"); do
    if curl -sf --connect-timeout 2 "http://${bind_address}:11434/api/tags" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  echo "Warning: Ollama API not ready on ${bind_address}:11434 after $((attempts * 2))s" >&2
  return 1
}

qtask_jetson_models_loaded() {
  local chat_model="${1:?chat model required}"
  local embed_model="${2:?embed model required}"

  docker exec qtask-ollama ollama ps 2>/dev/null | grep -Fq "${chat_model}" \
    && docker exec qtask-ollama ollama ps 2>/dev/null | grep -Fq "${embed_model}"
}

qtask_warm_jetson_models() {
  local bind_address="${1:?bind address required}"
  local chat_model="${2:-qwen3.5:2b}"
  local embed_model="${3:-nomic-embed-text}"

  qtask_wait_jetson_ollama_api "${bind_address}" || return 1

  if qtask_jetson_models_loaded "${chat_model}" "${embed_model}"; then
    echo "Models already loaded (${chat_model}, ${embed_model}); skipping warmup"
    return 0
  fi

  echo "Warming Jetson models (${chat_model}, ${embed_model})..."

  warm_agent_model() {
    curl -sf --max-time 300 \
      -H "Content-Type: application/json" \
      "http://${bind_address}:11434/api/chat" \
      -d "{\"model\":\"${chat_model}\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":false,\"keep_alive\":-1}" >/dev/null
  }

  warm_embedding_model() {
    curl -sf --max-time 300 \
      -H "Content-Type: application/json" \
      "http://${bind_address}:11434/api/embeddings" \
      -d "{\"model\":\"${embed_model}\",\"prompt\":\"warmup\",\"keep_alive\":-1,\"options\":{\"num_gpu\":0}}" >/dev/null
  }

  warm_agent_model
  warm_agent_model
  warm_embedding_model

  echo "Loaded models:"
  docker exec qtask-ollama ollama ps || true
}
