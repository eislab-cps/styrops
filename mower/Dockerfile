# Runtime-only image: the linux binary is built on the host by
# deployments/mower/build.sh (local go.mod replace makes in-container builds
# awkward). Web UI is embedded in the binary.
FROM debian:stable-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY bin/mower-linux-amd64 /usr/local/bin/mower
EXPOSE 9595
ENTRYPOINT ["/usr/local/bin/mower"]
