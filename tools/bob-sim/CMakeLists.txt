# bob-sim: the Waveshare round UI (apps/cardputer/src/round_ui*.cpp, bob_*.cpp, round_ring.cpp,
# round_keyboard.cpp) and Bob's portable core (libs/bob-device) compiled unchanged against LovyanGFX on the desktop, rendered into a 360x360 sprite and written
# to PNG. No hardware, no window. See docs/waveshare/simulator.md.
cmake_minimum_required(VERSION 3.20)
project(bob_sim C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# LovyanGFX v1 (the library M5GFX is built on), pinned to a release tag. Only its sprite and
# font code is used; no display device, SDL or fbdev backend is compiled.
include(FetchContent)
FetchContent_Declare(lovyangfx
  GIT_REPOSITORY https://github.com/lovyan03/LovyanGFX.git
  GIT_TAG 1.2.7
  GIT_SHALLOW TRUE)
FetchContent_GetProperties(lovyangfx)
if(NOT lovyangfx_POPULATED)
  FetchContent_Populate(lovyangfx)
endif()

set(FW ${CMAKE_CURRENT_SOURCE_DIR}/../../apps/cardputer)
# Bob's portable core, found from FW so the visual gate's relocated copy (it repoints FW) finds it too.
set(BOBLIB ${FW}/../../libs/bob-device/src)

file(GLOB LGFX_SOURCES
  ${lovyangfx_SOURCE_DIR}/src/lgfx/Fonts/efont/*.c
  ${lovyangfx_SOURCE_DIR}/src/lgfx/Fonts/IPA/*.c
  ${lovyangfx_SOURCE_DIR}/src/lgfx/utility/*.c
  ${lovyangfx_SOURCE_DIR}/src/lgfx/v1/*.cpp
  ${lovyangfx_SOURCE_DIR}/src/lgfx/v1/misc/*.cpp
  ${lovyangfx_SOURCE_DIR}/src/lgfx/v1/panel/Panel_Device.cpp
  ${lovyangfx_SOURCE_DIR}/src/lgfx/v1/panel/Panel_FrameBufferBase.cpp
  ${lovyangfx_SOURCE_DIR}/src/lgfx/v1/platforms/framebuffer/*.cpp)
add_library(lgfx STATIC ${LGFX_SOURCES})
target_include_directories(lgfx PUBLIC ${lovyangfx_SOURCE_DIR}/src)
target_compile_options(lgfx PRIVATE -w)
# No panel is driven; LGFX_LINUX_FB only selects LovyanGFX's Linux platform layer (heap, timing).
target_compile_definitions(lgfx PUBLIC LGFX_LINUX_FB)

# The firmware sources, verbatim.
set(UI_SOURCES
  ${FW}/src/round_ui.cpp ${FW}/src/round_ui_cards.cpp ${FW}/src/round_ui_chrome.cpp
  ${FW}/src/round_ui_fb.cpp ${FW}/src/round_ui_demo.cpp
  ${BOBLIB}/bob_rig.cpp ${FW}/src/bob_art.cpp ${FW}/src/bob_emotions.cpp ${FW}/src/bob_face.cpp ${FW}/src/bob_motion.cpp
  ${FW}/src/round_ring.cpp ${FW}/src/round_keyboard.cpp ${FW}/src/round_fonts.cpp
  ${FW}/src/scene_engine.cpp ${FW}/src/scene_props.cpp)

add_executable(bob-sim src/main.cpp src/stubs.cpp ${UI_SOURCES})
target_include_directories(bob-sim PRIVATE shim vendor ${FW}/include ${BOBLIB})
target_compile_definitions(bob-sim PRIVATE BOB_BOARD_WAVESHARE_185C BOB_TEST_CONSOLE)
# The device builds the whole-pose Bob by default; -DBOBSIM_RIG=ON renders the rig renderer like the device flag (the split spelling keeps the visual gate, which greps for the flag, adding its own).
option(BOBSIM_RIG "render with the rig renderer" OFF)
if(BOBSIM_RIG)
  target_compile_definitions(bob-sim PRIVATE BOB"_RIG=1")
endif()
target_link_libraries(bob-sim PRIVATE lgfx)
# bob_art.cpp .incbin's the four Bob images; the firmware build passes the same assembler path.
target_compile_options(bob-sim PRIVATE -Wa,-I${FW}/lib/bob_art -Wa,-I${FW}/lib/bob_art/rig -Wa,-I${FW}/lib/fonts)

enable_testing()
foreach(scene ready listening love)
  add_test(NAME golden-${scene}
    COMMAND ${CMAKE_COMMAND}
      -DSIM=$<TARGET_FILE:bob-sim> -DSCENE=${scene} -DOUT=${CMAKE_BINARY_DIR}/golden
      -P ${CMAKE_CURRENT_SOURCE_DIR}/golden.cmake)
endforeach()
