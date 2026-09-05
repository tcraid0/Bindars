#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <bundle-directory> <evidence-directory>" >&2
  exit 2
fi

bundle_directory="$1"
evidence_directory="$2"
expected_version="$(node -p "require('./package.json').version")"

mapfile -d '' deb_packages < <(
  find "$bundle_directory" -maxdepth 1 -type f -name '*.deb' -print0
)

if [ "${#deb_packages[@]}" -ne 1 ]; then
  echo "Expected exactly one Debian package, found ${#deb_packages[@]}." >&2
  exit 1
fi

deb_path="${deb_packages[0]}"
package_name="$(dpkg-deb --field "$deb_path" Package)"
package_version="$(dpkg-deb --field "$deb_path" Version)"
package_architecture="$(dpkg-deb --field "$deb_path" Architecture)"
package_dependencies="$(dpkg-deb --field "$deb_path" Depends)"

test "$package_name" = "bindars"
test "$package_version" = "$expected_version"
test "$package_architecture" = "amd64"
grep -q 'libwebkit2gtk-4.1-0' <<< "$package_dependencies"
grep -q 'libgtk-3-0' <<< "$package_dependencies"

mkdir -p "$evidence_directory"
deb_filename="$(basename "$deb_path")"
cp "$deb_path" "$evidence_directory/$deb_filename"
dpkg-deb --field "$deb_path" > "$evidence_directory/deb-control.txt"
dpkg-deb --contents "$deb_path" > "$evidence_directory/deb-files.txt"
(
  cd "$evidence_directory"
  sha256sum "$deb_filename" > SHA256SUMS
)

extract_directory="$(mktemp -d)"
trap 'rm -rf "$extract_directory"' EXIT
dpkg-deb --extract "$deb_path" "$extract_directory"

binary_path="$extract_directory/usr/bin/bindars"
test -x "$binary_path"
file "$binary_path" | grep -q 'ELF 64-bit.*x86-64'
ldd "$binary_path" > "$evidence_directory/ldd.txt"
if grep -q 'not found' "$evidence_directory/ldd.txt"; then
  cat "$evidence_directory/ldd.txt" >&2
  echo "The packaged binary has unresolved shared-library dependencies." >&2
  exit 1
fi

mapfile -t notice_files < <(
  find "$extract_directory" -type f -name THIRD-PARTY-NOTICES -print
)
if [ "${#notice_files[@]}" -ne 1 ]; then
  echo "Expected exactly one THIRD-PARTY-NOTICES file, found ${#notice_files[@]}." >&2
  exit 1
fi
cmp THIRD-PARTY-NOTICES "${notice_files[0]}"

mapfile -t project_license_files < <(
  find "$extract_directory" -type f -name LICENSE -print
)
if [ "${#project_license_files[@]}" -ne 1 ]; then
  echo "Expected exactly one project LICENSE file, found ${#project_license_files[@]}." >&2
  exit 1
fi
cmp LICENSE "${project_license_files[0]}"

bundled_library="$(
  find "$extract_directory" -type f \( -name '*.so' -o -name '*.so.*' \) -print -quit
)"
if [ -n "$bundled_library" ]; then
  echo "Unexpected bundled shared library: $bundled_library" >&2
  exit 1
fi

echo "Verified $deb_filename ($package_version, $package_architecture)."
