#!/usr/bin/env bash
set -euo pipefail

# ------- 설정 (고정 값: 네가 준 값) -------
BOOTPARAM_URL="https://github.com/waLLLnut/LatticA/releases/download/bootparam/bootparam.bin"
BOOTPARAM_SHA="9f57d703e4dd87e2bf2e72c521a4538adf15c0535d1e8fa31eb504e28b94e873"
BOOTPARAM_DEST="./FHE16/store/boot/bootparam.bin"

SECRET_URL="https://github.com/waLLLnut/LatticA/releases/download/bootparam/secret.bin"
SECRET_SHA="8e72b47da587a8fe0de5c28824838503aea06721a1c19e76aa2a36af49393b17"
SECRET_DEST="./FHE16/store/keys/secret.bin"
# -----------------------------------------

curl_retry_opts=(--fail -L --retry 3 --retry-delay 1)

auth_header=()
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  auth_header=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

download_verify () {
  local url="$1" dest="$2" sha="$3"

  mkdir -p "$(dirname "$dest")"
  local tmp="${dest}.download"

  echo "[download] $url -> $dest"
  # 다운로드
  curl "${curl_retry_opts[@]}" "${auth_header[@]}" -o "$tmp" "$url"

  # SHA256 검증
  if command -v sha256sum >/dev/null 2>&1; then
    got="$(sha256sum "$tmp" | awk '{print $1}')"
  else
    # macOS 호환
    got="$(shasum -a 256 "$tmp" | awk '{print $1}')"
  fi

  if [[ "${got,,}" != "${sha,,}" ]]; then
    echo "❌ sha256 mismatch"
    echo "   got:    $got"
    echo "   expect: $sha"
    rm -f "$tmp"
    exit 1
  fi

  # 원자적 교체
  mv -f "$tmp" "$dest"
  # 접근권한(키/파라미터 파일이니 제한)
  chmod 600 "$dest" || true
  echo "✅ saved: $dest"
}

download_verify "$BOOTPARAM_URL" "$BOOTPARAM_DEST" "$BOOTPARAM_SHA"
download_verify "$SECRET_URL"     "$SECRET_DEST"     "$SECRET_SHA"

