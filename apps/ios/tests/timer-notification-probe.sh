#!/bin/bash
set -euo pipefail
# Run after BobKit's Swift tests. This checks the actual OS request adapter,
# without asking for Mac permission or claiming delivery on a phone.
test_dir="$(cd "$(dirname "$0")" && pwd)"
ios_dir="$(dirname "$test_dir")"
build_dir="$(swift build --package-path "$ios_dir/BobKit" --show-bin-path)"
probe_dir="$(mktemp -d)"
trap 'rm -rf "$probe_dir"' EXIT
swiftc -warnings-as-errors -I "$build_dir/Modules" "$build_dir"/BobKit.build/*.o \
  "$ios_dir/Bob/Bob/Notifications/TimerNotificationScheduler.swift" \
  "$test_dir/timer-notification-probe.swift" -o "$probe_dir/timer-notification-probe"
"$probe_dir/timer-notification-probe"
