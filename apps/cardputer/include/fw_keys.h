#pragma once
#include <stddef.h>

struct FwKey { const char* id; const char* pem; };
static const FwKey kFwKeys[] = {
  { "fw-2026a", "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfSOubeKb9VG7zjqyIDUWFkJA013m\nDe2iJJ5JacYElx6DsW8Up9vzhCJ/FeHwjLhmavPmz9gLcXrHlmeNcm5anQ==\n-----END PUBLIC KEY-----\n" },
#ifdef BOB_DEV_OPTIONS  // the HIL key is trusted by dev builds only; release builds unflag this.
  { "fw-hil", "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWTqr8ZsGxHfmP7bkbQnHL2U20HHh\nOScjLOShsUcdAsLsWO/yHZMJHhrBoWs7DZx8J2v3f6a1iyLwDPNj4FA3qw==\n-----END PUBLIC KEY-----\n" },
#endif
};
static const size_t kFwKeyCount = sizeof(kFwKeys) / sizeof(kFwKeys[0]);
