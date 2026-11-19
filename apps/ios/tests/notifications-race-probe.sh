#!/bin/bash
set -euo pipefail
# Run after `swift test --package-path apps/ios/BobKit` has built BobKit.
# Compiles the real app model with only its platform-independent service seams.
test_dir="$(cd "$(dirname "$0")" && pwd)"
ios_dir="$(dirname "$test_dir")"
build_dir="$(swift build --package-path "$ios_dir/BobKit" --show-bin-path)"
probe_dir="$(mktemp -d)"
trap 'rm -rf "$probe_dir"' EXIT
swiftc -I "$build_dir/Modules" "$build_dir"/BobKit.build/*.o \
  "$ios_dir/Bob/Bob/Notifications/NotificationsModel.swift" \
  "$test_dir/notifications-race-probe.swift" -o "$probe_dir/notifications-race-probe"
"$probe_dir/notifications-race-probe"
