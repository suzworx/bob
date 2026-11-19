#!/bin/sh
# Container entry: the Dockerfile's CMD, run under tini from /app.
#
# Execs the entry the root `start` script runs (`tsx src/server.ts` from
# apps/api, expressed from /app). Configuration comes from the container's
# environment; see .env.example for the variables.
set -eu

exec node --import tsx apps/api/src/server.ts
