// Bob Cardputer v2 — which build this is, for the boot journal line, the
// boot/connecting screen, HELP and the HIL console's `T ping`.
#pragma once

#include "types.h"

// platformio.ini injects the short git sha as a bare token (-DBOB_BUILD_ID);
// "dev" in a build without it.
#define BOB_STRINGIFY_(x) #x
#define BOB_STRINGIFY(x) BOB_STRINGIFY_(x)
#ifdef BOB_BUILD_ID
#define BOB_BUILD_ID_TEXT BOB_STRINGIFY(BOB_BUILD_ID)
#else
#define BOB_BUILD_ID_TEXT "dev"
#endif
