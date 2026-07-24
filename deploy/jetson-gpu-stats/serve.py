#!/usr/bin/env python3
"""Minimal HTTP server for on-demand Jetson GPU stats."""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

from read_gpu import read_gpu_stats

HOST = os.environ.get("JETSON_GPU_STATS_HOST", "0.0.0.0")
PORT = int(os.environ.get("JETSON_GPU_STATS_PORT", "9401"))
VERSION_FILE = os.environ.get("QTASK_VERSION_FILE", "/qtask/VERSION")


def read_stack_version() -> dict:
    try:
        with open(VERSION_FILE, encoding="utf-8") as handle:
            version = handle.read().strip()
        if not version:
            return {"component": "qtask-ollama", "version": None, "error": "empty"}
        return {"component": "qtask-ollama", "version": version}
    except OSError as exc:
        return {"component": "qtask-ollama", "version": None, "error": str(exc)}


class GpuStatsHandler(BaseHTTPRequestHandler):
    server_version = "jetson-gpu-stats/1.0"

    def log_message(self, format: str, *args: object) -> None:
        return

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path in ("/health", "/health/"):
            self._send_json(200, {"ok": True})
            return

        if self.path in ("/gpu", "/gpu/"):
            self._send_json(200, read_gpu_stats())
            return

        if self.path in ("/version", "/version/"):
            payload = read_stack_version()
            status = 200 if payload.get("version") else 404
            self._send_json(status, payload)
            return

        self._send_json(404, {"error": "not found"})


def main() -> None:
    server = HTTPServer((HOST, PORT), GpuStatsHandler)
    print(f"jetson-gpu-stats listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
