#!/usr/bin/env bash
# Ensure QTask runtime dir exists and is writable by qtask (mongo.env, etc.).
ensure_qtask_run_dir() {
  local run_dir="${1:?run directory required}"

  if [[ -d "${run_dir}" && ! -w "${run_dir}" ]]; then
    if sudo -n chown -R "$(id -un):$(id -gn)" "${run_dir}" 2>/dev/null; then
      :
    else
      echo "Error: ${run_dir} is not writable by $(id -un)." >&2
      echo "One-time fix (as admin): sudo chown -R qtask:qtask ${run_dir} && sudo chmod 700 ${run_dir}" >&2
      return 1
    fi
  fi

  mkdir -p "${run_dir}"
  chmod 700 "${run_dir}" 2>/dev/null || sudo -n chmod 700 "${run_dir}" 2>/dev/null || true

  local mongo_env="${run_dir}/mongo.env"
  if [[ -f "${mongo_env}" && ! -w "${mongo_env}" ]]; then
    rm -f "${mongo_env}" 2>/dev/null || sudo -n rm -f "${mongo_env}" 2>/dev/null || {
      echo "Error: cannot write ${mongo_env} (wrong ownership)." >&2
      echo "One-time fix (as admin): sudo rm -f ${mongo_env} && sudo chown -R qtask:qtask ${run_dir}" >&2
      return 1
    }
  fi
}
