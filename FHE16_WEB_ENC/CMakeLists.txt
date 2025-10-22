cmake_minimum_required(VERSION 3.20)
project(FHE16_WASM LANGUAGES CXX)

# ===== 옵션 =====
option(FHE16_EMBED_PK   "Embed assets/pk.bin into wasm as /pk.bin" OFF)
option(FHE16_PRELOAD_PK "Preload assets/pk.bin into .data as /pk.bin" OFF)
set(FHE16_EXPORT_NAME "createFHE16" CACHE STRING "Emscripten module factory name")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# EMSCRIPTEN 감지
if(CMAKE_SYSTEM_NAME STREQUAL "Emscripten")
  set(EMSCRIPTEN 1)
endif()

# ===== 소스 =====
add_executable(fhe16
  src/enc_wasm.cpp
)

# ===== 공통 컴파일 옵션 =====
target_compile_options(fhe16 PRIVATE -O3)

if(EMSCRIPTEN)
  message(STATUS "Building with Emscripten")

  # pk.bin 위치(소스 루트 기준)
  set(PK_FILE "${CMAKE_SOURCE_DIR}/assets/pk.bin")
  if(EXISTS "${PK_FILE}")
    message(STATUS "PK file found: ${PK_FILE}")
  else()
    message(WARNING "PK file NOT found: ${PK_FILE} (HTTP fetch fallback만 사용 가능)")
  endif()

  # 런타임/모듈 설정
  target_link_options(fhe16 PRIVATE
    "-sMODULARIZE=1"
    "-sEXPORT_NAME=${FHE16_EXPORT_NAME}"
    "-sENVIRONMENT=web,worker,node"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sFORCE_FILESYSTEM=1"
    "-sEXPORTED_RUNTIME_METHODS=FS,ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8"
    # JS에서 _접두로 직접 호출할 함수들만 노출
    "-sEXPORTED_FUNCTIONS=_malloc,_free,_FHE16_init_params,_FHE16_set_pk,_FHE16_load_pk_from_fs,_FHE16_ENC_WASM,_FHE16_free"
  )

  # === pk.bin 탑재 방법 선택 ===
  if(FHE16_EMBED_PK AND EXISTS "${PK_FILE}")
    message(STATUS "Embedding pk.bin into wasm as /pk.bin")
    # ⚠️ SHELL: 로 한 덩어리 전달 (툴체인이 토큰 분리하는 문제 방지)
    target_link_options(fhe16 PRIVATE "SHELL:--embed-file ${PK_FILE}@/pk.bin")
    # 임베드 사용 시 .data 파일은 생성되지 않음
  elseif(FHE16_PRELOAD_PK AND EXISTS "${PK_FILE}")
    message(STATUS "Preloading pk.bin into .data as /pk.bin")
    target_link_options(fhe16 PRIVATE "SHELL:--preload-file ${PK_FILE}@/pk.bin")
  else()
    # 임베드/프리로드를 사용하지 않으면 빌드 산출물 옆으로 복사 (HTTP fetch fallback)
    if(EXISTS "${PK_FILE}")
      add_custom_command(TARGET fhe16 POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${PK_FILE}" "$<TARGET_FILE_DIR:fhe16>/pk.bin"
        COMMENT "Copying pk.bin next to fhe16.js for HTTP-fetch fallback."
      )
    endif()
  endif()

  # 산출물 이름: fhe16.js / fhe16.wasm
  set_target_properties(fhe16 PROPERTIES OUTPUT_NAME "fhe16")

	add_custom_command(TARGET fhe16 POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "$<TARGET_FILE_DIR:fhe16>/fhe16.js" "${CMAKE_SOURCE_DIR}/test_page/fhe16.js"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "$<TARGET_FILE_DIR:fhe16>/fhe16.wasm" "${CMAKE_SOURCE_DIR}/test_page/fhe16.wasm"
  COMMENT "Copying fhe16.js and fhe16.wasm to test_page directory"
)


else()
  message(STATUS "Building natively (no Emscripten)")
  # 필요시 네이티브용 라이브러리/옵션 추가
endif()

