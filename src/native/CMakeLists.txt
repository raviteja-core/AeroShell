cmake_minimum_required(VERSION 3.15)
cmake_policy(SET CMP0091 NEW)
project(aero_win_bridge LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

execute_process(COMMAND node -p "require('node-addon-api').include"
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR OUTPUT_STRIP_TRAILING_WHITESPACE)
string(REPLACE "\"" "" NODE_ADDON_API_DIR "${NODE_ADDON_API_DIR}")

# cmake-js on Windows: generate node.lib for Node-API
if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
  execute_process(COMMAND ${CMAKE_AR} /def:${CMAKE_JS_NODELIB_DEF}
                  /out:${CMAKE_JS_NODELIB_TARGET} ${CMAKE_STATIC_LINKER_FLAGS})
endif()

add_library(${PROJECT_NAME} SHARED
  binding.cc win_memory.cc win_gpu.cc win_registry.cc ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

# Treat Node-API and Node headers as external/SYSTEM so /WX only enforces zero warnings on our code
target_include_directories(${PROJECT_NAME} SYSTEM PRIVATE ${CMAKE_JS_INC} ${NODE_ADDON_API_DIR})
target_include_directories(${PROJECT_NAME} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

target_compile_definitions(${PROJECT_NAME} PRIVATE
  NAPI_VERSION=9 NAPI_CPP_EXCEPTIONS NOMINMAX WIN32_LEAN_AND_MEAN UNICODE _UNICODE)
target_compile_options(${PROJECT_NAME} PRIVATE
  /W4 /WX /EHsc /guard:cf /Zi /external:anglebrackets /external:W0)
target_link_options(${PROJECT_NAME} PRIVATE
  /DEBUG /OPT:REF /OPT:ICF /DYNAMICBASE /NXCOMPAT /CETCOMPAT /GUARD:CF)
target_link_libraries(${PROJECT_NAME} PRIVATE
  ${CMAKE_JS_LIB} dxgi.lib advapi32.lib)
