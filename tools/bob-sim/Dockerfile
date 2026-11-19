# gcc 14.2 (same pin as apps/cardputer/test/host/run.mjs) plus cmake for the bob-sim build.
FROM gcc:14.2.0@sha256:b99b86a28812b1e6453a231a947dc43d76fe192788a12f344a9b568bf9f5d24c
RUN apt-get update && apt-get install -y --no-install-recommends cmake ninja-build && rm -rf /var/lib/apt/lists/*
