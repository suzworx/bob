// Public releases cannot preserve the private, unredistributable Hey Bob candidate model.
#pragma once

namespace bob {
#ifdef BOB_WAKE_MODEL_BOB
constexpr bool kAcceptStandardOta = false;
#else
constexpr bool kAcceptStandardOta = true;
#endif
}  // namespace bob
