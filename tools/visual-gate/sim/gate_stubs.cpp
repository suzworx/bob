// Visual-gate stubs: weak stand-ins for firmware hooks a newer round UI calls but the checkout's bob-sim stubs
// may not provide yet. A strong definition (the checkout's own stubs.cpp) always wins.
namespace bob
{
__attribute__((weak)) float captureLevel01() { return 0.0f; }
__attribute__((weak)) float playbackLevel01() { return 0.0f; }

// REST mode (bob_motion.cpp under -DBOBSIM_FREEZE=1). A firmware without the hooks links these instead: nothing
// freezes, and bob-sim --info reports freeze=0, so the gate stops rather than judging a moving Bob.
bool gateFreezeMissing = false;
__attribute__((weak)) void bobMotionFreeze(bool) { gateFreezeMissing = true; }
__attribute__((weak)) bool bobMotionPoseAt(const char*, float) { gateFreezeMissing = true; return false; }
} // namespace bob
