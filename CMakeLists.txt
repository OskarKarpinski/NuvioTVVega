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

install(TARGETS NuvioMediaProxy)
