#!/usr/bin/env bash
# Visual gate: stage the checkout's bob-sim at /work/sim with the gate's driver, so any firmware revision renders
# the same cases. Runs inside the bob-sim image with the checkout at /src and this folder at /gate.
# Nothing here inspects the checkout's CMake text: overlay.cmake, included last, adjusts the bob-sim target itself
# (missing UI sources, the rig variant from GATE_RIG, assembler paths). Missing Arduino pieces come from /gate/shim.
set -euo pipefail
rm -rf /work && mkdir -p /work
cp -r /src/tools/bob-sim /work/sim
cd /work/sim
cp /gate/main.cpp src/main.cpp
cp /gate/gate_stubs.cpp src/gate_stubs.cpp
cp /gate/textprobe.cpp src/textprobe.cpp
cp -n /gate/shim/* shim/
# The sim reaches the firmware as ../../apps/cardputer; point it at the mounted checkout.
sed -i 's#${CMAKE_CURRENT_SOURCE_DIR}/../../apps/cardputer#/src/apps/cardputer#' CMakeLists.txt
printf '\ninclude(/gate/overlay.cmake)\n' >> CMakeLists.txt
