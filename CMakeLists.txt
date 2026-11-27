cmake_minimum_required(VERSION 3.15)

project(nuviotvvega
        VERSION 1.0
        LANGUAGES CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_link_options("LINKER:--no-undefined" "LINKER:-z,defs")
endif()

if(CMAKE_SYSTEM_NAME STREQUAL Android)
  add_compile_definitions(ANDROID)
endif()

set(HEADERS
  kepler/turbo-modules/generated/NuvioMediaProxySpec.h
  kepler/turbo-modules/NuvioMediaProxy.h
)
set(SOURCES
  kepler/turbo-modules/generated/NuvioMediaProxySpec.cpp
  kepler/turbo-modules/NuvioMediaProxy.cpp
  kepler/AutoLinkInit.cpp
)

find_package(turbomoduleAPI CONFIG REQUIRED)

kepler_add_turbo_module_library(NuvioMediaProxy SHARED ${HEADERS} ${SOURCES})
target_link_libraries(NuvioMediaProxy PRIVATE dl)

install(TARGETS NuvioMediaProxy)

# Kepler apps have their own /usr/lib inside the sandbox with an incompatible
# libav* ABI. Ship the complete FFmpeg runtime next to the TurboModule and run
# it through the packaged loader, so playback never uses system tools/libs.
if(VODKA_ARCH STREQUAL "armv7")
  install(DIRECTORY kepler/turbo-modules/libs/armv7/ DESTINATION lib USE_SOURCE_PERMISSIONS)
  install(DIRECTORY kepler/turbo-modules/bin/armv7/ DESTINATION lib USE_SOURCE_PERMISSIONS)
endif()
