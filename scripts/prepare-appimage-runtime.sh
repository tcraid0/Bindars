#!/usr/bin/env bash
set -euo pipefail

RUNTIME_CACHE_PATH="${HOME}/.cache/tauri/type2-runtime-x86_64-offline"
LINUXDEPLOY_APPIMAGE_PATH="${HOME}/.cache/tauri/linuxdeploy-x86_64.AppImage"

has_digest_section() {
  local path="$1"
  readelf -S "$path" 2>/dev/null | rg -q '\.digest_md5'
}

if [[ -f "$RUNTIME_CACHE_PATH" ]] && has_digest_section "$RUNTIME_CACHE_PATH"; then
  printf '%s\n' "$RUNTIME_CACHE_PATH"
  exit 0
fi

if [[ ! -x "$LINUXDEPLOY_APPIMAGE_PATH" ]]; then
  printf 'Missing linuxdeploy cache at: %s\n' "$LINUXDEPLOY_APPIMAGE_PATH" >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

(
  cd "$tmpdir"
  "$LINUXDEPLOY_APPIMAGE_PATH" --appimage-extract >/dev/null
)

appimagetool_bin="${tmpdir}/squashfs-root/plugins/linuxdeploy-plugin-appimage/appimagetool-prefix/usr/bin/appimagetool"
if [[ ! -f "$appimagetool_bin" ]]; then
  appimagetool_bin="${tmpdir}/squashfs-root/appimagetool-prefix/usr/bin/appimagetool"
fi

if [[ ! -f "$appimagetool_bin" ]]; then
  appimagetool_bin="${tmpdir}/squashfs-root/usr/bin/appimagetool"
fi

if [[ ! -f "$appimagetool_bin" ]]; then
  printf 'Unable to locate appimagetool in extracted plugin.\n' >&2
  exit 1
fi

runtime_fields="$(nm -S "$appimagetool_bin" | awk '$4 == "runtime" { print $1 " " $2; exit }')"
data_fields="$(readelf -W -S "$appimagetool_bin" | awk '$2 == ".data" { print $4 " " $5; exit }')"

if [[ -z "$runtime_fields" ]] || [[ -z "$data_fields" ]]; then
  printf 'Unable to derive runtime offsets from appimagetool binary.\n' >&2
  exit 1
fi

read -r runtime_vma_hex runtime_size_hex <<<"$runtime_fields"
read -r data_vma_hex data_offset_hex <<<"$data_fields"

runtime_vma=$((16#$runtime_vma_hex))
runtime_size=$((16#$runtime_size_hex))
data_vma=$((16#$data_vma_hex))
data_offset=$((16#$data_offset_hex))
runtime_offset=$((data_offset + runtime_vma - data_vma))

dd if="$appimagetool_bin" of="$RUNTIME_CACHE_PATH" bs=1 skip="$runtime_offset" count="$runtime_size" status=none

if ! has_digest_section "$RUNTIME_CACHE_PATH"; then
  printf 'Extracted runtime is missing required .digest_md5 section.\n' >&2
  exit 1
fi

chmod 0644 "$RUNTIME_CACHE_PATH"
printf '%s\n' "$RUNTIME_CACHE_PATH"
