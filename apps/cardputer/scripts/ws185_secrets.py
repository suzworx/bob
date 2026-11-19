"""PlatformIO pre-build for env:waveshare-s3-185c: a build-tree secrets.h that keeps the
Wi-Fi settings from the developer's secrets.h but makes Production (api.heybob.xyz:443, TLS)
the server the first boot seeds, instead of the LAN dev host.

config.h includes "secrets.h", so the seeded server profile is whatever V2_HOST says. This
board has no LAN server to talk to, so the wrapper includes the real file and then redefines
V2_HOST / V2_PORT / V2_USE_TLS. The real file is never edited, printed or copied into git:

  source  $BOB_SECRETS_SRC, else .pio/ws185-secrets/secrets.real.h (git-ignored)
  output  <build dir>/ws185-secrets/secrets.h, put first on the include path

include/secrets.h must not exist for this env: config.h would find it before the wrapper.
"""
import os
from pathlib import Path

Import("env")

project = Path(env.subst("$PROJECT_DIR"))
build = Path(env.subst("$BUILD_DIR")) / "ws185-secrets"
real = Path(os.environ.get("BOB_SECRETS_SRC", project / ".pio" / "ws185-secrets" / "secrets.real.h"))

if (project / "include" / "secrets.h").exists():
    raise SystemExit(
        "waveshare-s3-185c: include/secrets.h exists and would shadow the Production wrapper. "
        "Move it to .pio/ws185-secrets/secrets.real.h (or set BOB_SECRETS_SRC) and rebuild."
    )

lines = ["#pragma once"]
if real.is_file():
    lines.append('#include "%s"' % real.resolve().as_posix())
else:
    print("waveshare-s3-185c: no secrets source at %s: no Wi-Fi network is seeded" % real)
lines += [
    "#undef V2_HOST",
    '#define V2_HOST "api.heybob.xyz"',
    "#undef V2_PORT",
    "#define V2_PORT 443",
    "#undef V2_USE_TLS",
    "#define V2_USE_TLS 1",
]
build.mkdir(parents=True, exist_ok=True)
(build / "secrets.h").write_text("\n".join(lines) + "\n")
env.Append(CPPPATH=[str(build)])
