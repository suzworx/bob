// Bob Cardputer v2 — push-to-talk voice client for the Bob v2 server.
// Modular entry point: setup/loop delegate to the state machine.
#include "state.h"

void setup() { bob::stateSetup(); }

void loop() { bob::stateLoop(); }
