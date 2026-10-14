#!/usr/bin/env bash

set -euo pipefail

REPO="arklanq/block-attribution"
VERSION="${BLOCK_ATTRIBUTION_VERSION:-latest}"
RELEASE_BASE_URL="${BLOCK_ATTRIBUTION_RELEASE_BASE_URL:-https://github.com/${REPO}/releases}"
installer_args=()

usage() {
  cat <<'USAGE'
Usage: install.sh [--version <tag>] [installer options]

Options:
  --version <tag>               Install a specific release, for example v1.2.3.
  --dry-run                     Show the changes without writing anything.
  --yes, --non-interactive      Do not ask; use flags, saved answers, then defaults.
  --skip-claude                 Do not configure Claude Code.
  --skip-codex                  Do not configure Codex.
  --git-hooks, --no-git-hooks   Install global git hooks (default: yes).
  --remove-git-instructions, --keep-git-instructions
                                Remove Claude Code's built-in commit and PR instructions (default: keep).
  -h, --help                    Show this help.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      if [ -z "${2:-}" ] || [[ "$2" == --* ]]; then
        echo "--version requires a release tag." >&2
        exit 1
      fi
      VERSION="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --dry-run|--yes|--non-interactive|--skip-claude|--skip-codex|--git-hooks|--no-git-hooks|--remove-git-instructions|--keep-git-instructions)
      installer_args+=("$1")
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to install Block Attribution." >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) echo "Unsupported operating system: $(uname -s)." >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)." >&2; exit 1 ;;
esac

binary_name="block-attribution-${os}-${arch}"
if [ "$VERSION" = "latest" ]; then
  download_base="${RELEASE_BASE_URL}/latest/download"
else
  download_base="${RELEASE_BASE_URL}/download/${VERSION}"
fi

temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/block-attribution-install.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT
binary_path="${temporary_dir}/${binary_name}"
checksum_path="${binary_path}.sha256"

echo "Downloading Block Attribution ${VERSION} for ${os}-${arch}..."
curl -fsSL "${download_base}/${binary_name}" -o "$binary_path"
curl -fsSL "${download_base}/${binary_name}.sha256" -o "$checksum_path"

expected_checksum="$(awk -v name="$binary_name" '$2 == name { print $1 }' "$checksum_path")"
if [ "${#expected_checksum}" -ne 64 ] || [[ "$expected_checksum" == *[!0-9a-fA-F]* ]]; then
  echo "The downloaded checksum file is invalid." >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual_checksum="$(sha256sum "$binary_path" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual_checksum="$(shasum -a 256 "$binary_path" | awk '{ print $1 }')"
else
  echo "sha256sum or shasum is required to verify the download." >&2
  exit 1
fi

if [ "$actual_checksum" != "$expected_checksum" ]; then
  echo "SHA-256 verification failed. Refusing to run the downloaded file." >&2
  exit 1
fi

chmod +x "$binary_path"

# Prints the terminal device path, e.g. /dev/ttys001. The installer cannot read from /dev/tty
# itself on macOS: kqueue does not support that device, so keystrokes never arrive.
terminal_device() {
  local name
  name="$(ps -o tty= -p "$$" 2>/dev/null | tr -d '[:space:]')"
  case "$name" in
    ""|"?"|"??") return 1 ;;
  esac
  [ -c "/dev/${name}" ] && [ -r "/dev/${name}" ] || return 1
  printf '/dev/%s\n' "$name"
}

# With `curl | bash`, stdin is the script itself; read the setup wizard's answers from the terminal.
run_installer() {
  local device
  if [ ! -t 0 ] && device="$(terminal_device)"; then
    "$@" <"$device"
  else
    "$@"
  fi
}

if [ "${#installer_args[@]}" -eq 0 ]; then
  run_installer "$binary_path" install
else
  run_installer "$binary_path" install "${installer_args[@]}"
fi

