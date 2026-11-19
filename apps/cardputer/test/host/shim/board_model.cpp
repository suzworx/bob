// Host-test definition of board::model() (the firmware's lives in src/board_*.cpp).
#include "types.h"

namespace bob {
namespace board {
const char* model() { return kDeviceModel; }
}  // namespace board
}  // namespace bob
