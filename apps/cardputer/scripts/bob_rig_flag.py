"""PlatformIO pre-build for the Waveshare envs: turn Bob's rig renderer on when its part blobs exist.

libs/bob-device/src/bob_rig.cpp .incbin's lib/bob_art/rig/*.rgb565a8 (written by scripts/bob_rig_build.py --device-blobs, committed).
With every blob present this defines BOB_RIG, and src/bob_motion.cpp draws Bob from independent parts. With
any blob missing it prints a warning and leaves the flag off, so the firmware still builds and Bob falls back to the
four whole-pose images (the pre-rig look).
"""
import json
import os
from pathlib import Path

Import("env")

project = Path(env.subst("$PROJECT_DIR"))
rig = project / "lib" / "bob_art" / "rig"
parts = json.loads((project / "assets" / "bob" / "rig" / "rig.json").read_text())["parts"]
missing = [p["file"] for p in parts.values() if not (rig / p["file"]).is_file()]
if os.environ.get("BOB_RIG") != "1":
    # OFF by default (owner, 2026-10-16): the rig renderer's rotated parts are rougher than the whole-pose art until
    # BOB-RIG-POLISH-FW proves a screenshot burst that matches it. Set BOB_RIG=1 to build the rig renderer.
    print("bob_rig_flag: rig renderer off (set BOB_RIG=1 to build it); whole-pose Bob")
elif missing:
    print("bob_rig_flag: %d rig blob(s) missing in lib/bob_art/rig (first: %s); building the whole-pose Bob" % (len(missing), missing[0]))
else:
    env.Append(CPPDEFINES=[("BOB_RIG", 1)])
