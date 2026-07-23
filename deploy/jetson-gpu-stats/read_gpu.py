#!/usr/bin/env python3
"""Read Jetson GPU stats from sysfs (autodetected paths)."""

from __future__ import annotations

import glob
import json
import os
import sys
from typing import Any

GPU_LOAD_CANDIDATES = (
    "/sys/devices/gpu.0/load",
    "/sys/devices/platform/host1x/gpu.0/load",
)

_cached_gpu_load_path: str | None = None


def _read_text(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        return None


def _read_int(path: str) -> int | None:
    text = _read_text(path)
    if text is None:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def _is_gpu_utilization_load_path(path: str) -> bool:
    """True for overall GPU load (…/gpu/load), not engine-specific …/nvenc0_load files."""
    if os.path.basename(path) != "load":
        return False
    parent = os.path.basename(os.path.dirname(path))
    return "gpu" in parent.lower()


def _glob_gpu_load_paths() -> list[str]:
    paths: list[str] = []
    seen: set[str] = set()

    def add(path: str) -> None:
        if path not in seen:
            seen.add(path)
            paths.append(path)

    for path in GPU_LOAD_CANDIDATES:
        add(path)
    for path in sorted(glob.glob("/sys/devices/*gpu*/load")):
        add(path)
    for path in sorted(glob.glob("/sys/devices/**/load", recursive=True)):
        if _is_gpu_utilization_load_path(path):
            add(path)
    return paths


def discover_gpu_load_path() -> str | None:
    global _cached_gpu_load_path

    if _cached_gpu_load_path and os.path.isfile(_cached_gpu_load_path):
        return _cached_gpu_load_path

    for path in _glob_gpu_load_paths():
        if _read_int(path) is not None:
            _cached_gpu_load_path = path
            return path

    _cached_gpu_load_path = None
    return None


def read_gpu_utilization_percent() -> float | None:
    path = discover_gpu_load_path()
    if not path:
        return None
    raw = _read_int(path)
    if raw is None:
        global _cached_gpu_load_path
        _cached_gpu_load_path = None
        return None
    return raw / 10.0


def read_gpu_temperature_c() -> float | None:
    thermal_root = "/sys/class/thermal"
    if not os.path.isdir(thermal_root):
        return None

    for zone_dir in sorted(glob.glob(os.path.join(thermal_root, "thermal_zone*"))):
        zone_type = _read_text(os.path.join(zone_dir, "type"))
        if not zone_type or "gpu" not in zone_type.lower():
            continue
        temp_milli = _read_int(os.path.join(zone_dir, "temp"))
        if temp_milli is not None:
            return temp_milli / 1000.0

    return None


def read_memory_mib() -> tuple[int | None, int | None]:
    total_kb = None
    available_kb = None
    try:
        with open("/proc/meminfo", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("MemTotal:"):
                    total_kb = int(line.split()[1])
                elif line.startswith("MemAvailable:"):
                    available_kb = int(line.split()[1])
    except OSError:
        return None, None

    if total_kb is None:
        return None, None

    total_mib = total_kb // 1024
    if available_kb is None:
        return None, total_mib

    used_mib = max(0, (total_kb - available_kb) // 1024)
    return used_mib, total_mib


def read_power_watts() -> float | None:
    for path in sorted(glob.glob("/sys/bus/i2c/drivers/ina3221/*/iio:device*/in_power*_input")):
        milliwatts = _read_int(path)
        if milliwatts is not None and milliwatts > 0:
            return milliwatts / 1000.0
    return None


def read_gpu_stats() -> dict[str, Any]:
    gpu_load_path = discover_gpu_load_path()
    utilization = read_gpu_utilization_percent()
    temperature_c = read_gpu_temperature_c()
    memory_used_mib, memory_total_mib = read_memory_mib()
    power_watts = read_power_watts()

    if utilization is None and memory_used_mib is None:
        return {
            "available": False,
            "reason": "GPU sysfs paths not found on this device",
            "source": "jetson_sysfs",
        }

    result: dict[str, Any] = {
        "available": True,
        "source": "jetson_sysfs",
        "utilizationPercent": utilization,
        "memoryUsedMiB": memory_used_mib,
        "memoryTotalMiB": memory_total_mib,
        "temperatureC": temperature_c,
        "powerWatts": power_watts,
        "paths": {"gpuLoad": gpu_load_path},
    }
    if memory_used_mib is not None and memory_total_mib is not None:
        result["memoryFreeMiB"] = max(0, memory_total_mib - memory_used_mib)
    return result


def main() -> None:
    json.dump(read_gpu_stats(), sys.stdout)


if __name__ == "__main__":
    main()
