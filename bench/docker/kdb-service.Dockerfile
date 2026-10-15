# The published ghcr.io/dbeasty/kdb/kdb-service image is linux/amd64 only. This reproduces it
# for other architectures (arm64 Docker on Apple silicon) so the benchmark runs KDB natively
# rather than under emulation. Same base, user, layout, entrypoint, volume and ports as the
# published image (checked with `docker history` on v0.8.0); the binary is the same release's
# checksum-verified kdb-service-linux-<arch> asset, placed in the build context by
# bench/lib/docker.ts (ensureKdbImage).
FROM alpine:3.20
RUN adduser -D -u 10001 kdb && mkdir -p /var/lib/kdb && chown kdb:kdb /var/lib/kdb
COPY kdb-service /usr/local/bin/kdb-service
USER kdb
VOLUME /var/lib/kdb
EXPOSE 9090 9091 9092 9093
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:9093/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/kdb-service"]
CMD ["--data-dir", "/var/lib/kdb", "--admin-addr", "0.0.0.0:9093", "--sql-addr", "tcp://0.0.0.0:9090?bind=true", "--peer-addr", "tcp://0.0.0.0:9091?bind=true", "--stream-addr", "tcp://0.0.0.0:9092?bind=true"]
