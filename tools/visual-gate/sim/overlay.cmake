# Visual-gate overlay, included at the end of the checkout's bob-sim CMakeLists (sim/prepare.sh). It works on the
# bob-sim target as the checkout's CMake actually built it, not on that file's text: a comment, a split spelling
# or a renamed option cannot change what is compiled.
#   GATE_FW   the mounted firmware (apps/cardputer)
#   GATE_RIG  ON renders the rig renderer (BOB_RIG=1), OFF the whole-pose Bob, whatever the checkout defaults to
# BOBSIM_FREEZE=1 is always set: the gate captures Bob in REST mode.
# It prints one `visual-gate:` line that candidate.mjs records.

# 1. The round-UI sources a checkout has but its sim does not compile yet (the sim can lag its UI).
get_target_property(_gate_sources bob-sim SOURCES)
set(_gate_have "")
foreach(_s IN LISTS _gate_sources)
  get_filename_component(_abs "${_s}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
  list(APPEND _gate_have "${_abs}")
endforeach()
set(_gate_added "")
foreach(_name round_fonts scene_engine scene_props bob_rig)
  set(_f "${GATE_FW}/src/${_name}.cpp")
  if(EXISTS "${_f}" AND NOT "${_f}" IN_LIST _gate_have)
    target_sources(bob-sim PRIVATE "${_f}")
    list(APPEND _gate_added "${_name}.cpp")
  endif()
endforeach()
target_sources(bob-sim PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src/gate_stubs.cpp")

# 2. The rig variant, set from GATE_RIG alone: drop whatever rig define the checkout set, then add the gate's.
get_target_property(_gate_defs bob-sim COMPILE_DEFINITIONS)
if(_gate_defs)
  list(FILTER _gate_defs EXCLUDE REGEX "^BOB_RIG")
  set_property(TARGET bob-sim PROPERTY COMPILE_DEFINITIONS ${_gate_defs})
endif()
if(GATE_RIG)
  target_compile_definitions(bob-sim PRIVATE BOB_RIG=1)
endif()
# REST mode: the firmware's sim-only freeze hooks (bobMotionFreeze, bobMotionPoseAt, ring phase 0). Device builds never set it.
target_compile_definitions(bob-sim PRIVATE BOBSIM_FREEZE=1)

# 3. The assembler paths the firmware's .incbin's need (repeating one is harmless).
foreach(_d lib/bob_art lib/bob_art/rig lib/fonts)
  if(IS_DIRECTORY "${GATE_FW}/${_d}")
    target_compile_options(bob-sim PRIVATE "-Wa,-I${GATE_FW}/${_d}")
  endif()
endforeach()

# 4. The text probe for faithful.py: the device's own smooth-font path over the firmware's Nunito VLW fonts.
add_executable(gate-text "${CMAKE_CURRENT_SOURCE_DIR}/src/textprobe.cpp")
target_include_directories(gate-text PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/vendor")
target_link_libraries(gate-text PRIVATE lgfx)

message(STATUS "visual-gate: rig=${GATE_RIG} added-sources=${_gate_added}")
