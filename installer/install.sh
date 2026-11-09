#!/bin/sh
# Installs the Genesys Cloud Toolkit (gctk) on a Mac or Linux computer, with its own Node.js:
# nothing needs to be installed first. Double-click it, or run it in a terminal:
#   curl -fsSL https://github.com/diebergziege/gc-toolkit/releases/latest/download/install.sh | sh
#   ... | sh -s -- --partner      (gctk Partner: only the Partner page)
# Running it again updates gctk and its Node.js. Your orgs and settings stay.
set -eu

DEFAULT_EDITION=full
EDITION="${GCTK_EDITION:-$DEFAULT_EDITION}"
for a in "$@"; do
  case "$a" in
    --partner) EDITION=partner ;;
    --full) EDITION=full ;;
  esac
done
NODE_LINE=24
REPO=https://github.com/diebergziege/gc-toolkit
GCTK_DIR="${GCTK_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/gctk}"
NODE_DIR="$GCTK_DIR/node"
NODE="$NODE_DIR/bin/node"
if [ "$EDITION" = partner ]; then NAME="gctk Partner"; else NAME="gctk"; fi

say() { printf '%s\n' "$*"; }
fail() {
  say ""
  say "Installing $NAME did not work: $*"
  say "You can run the installer again; it picks up where it stopped."
  say "If it keeps failing, send a screenshot of this window to whoever sent you the download."
  exit 1
}

say "Installing $NAME (Genesys Cloud Toolkit). This takes a minute or two."
say ""

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) fail "this installer is for Mac and Linux; on Windows use the Windows download." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=x64 ;;
  *) fail "this computer's processor ($(uname -m)) is not supported." ;;
esac
# A Terminal that runs under Rosetta still gets the native Node.js.
if [ "$OS" = darwin ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then ARCH=arm64; fi

command -v curl >/dev/null 2>&1 || fail "curl is missing on this computer."
if command -v shasum >/dev/null 2>&1; then SHA="shasum -a 256"; else SHA="sha256sum"; fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/gctk-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# 1. Node.js: the newest release of the LTS line, checked against nodejs.org's checksums.
say "1/3  Node.js"
BASE="https://nodejs.org/dist/latest-v$NODE_LINE.x"
curl -fsSL -o "$TMP/SHASUMS256.txt" "$BASE/SHASUMS256.txt" || fail "nodejs.org could not be reached. Check the internet connection (or VPN) and try again."
FILE="$(grep -E " node-v[0-9.]+-$OS-$ARCH\.tar\.gz\$" "$TMP/SHASUMS256.txt" | awk '{print $2}')"
[ -n "$FILE" ] || fail "nodejs.org has no Node.js for $OS-$ARCH."
VERSION="$(printf '%s' "$FILE" | sed -E 's/^node-(v[0-9.]+)-.*/\1/')"
if [ -x "$NODE" ] && [ "$("$NODE" --version 2>/dev/null || true)" = "$VERSION" ]; then
  say "     Node.js $VERSION is there already."
else
  say "     Downloading Node.js $VERSION ..."
  curl -fL --progress-bar -o "$TMP/$FILE" "$BASE/$FILE" || fail "the download of Node.js stopped. Try again."
  WANT="$(grep " $FILE\$" "$TMP/SHASUMS256.txt" | awk '{print $1}')"
  GOT="$($SHA "$TMP/$FILE" | awk '{print $1}')"
  [ "$WANT" = "$GOT" ] || fail "the Node.js download is damaged (checksum differs). Try again."
  tar -xzf "$TMP/$FILE" -C "$TMP"
  mkdir -p "$NODE_DIR/bin"
  mv -f "$TMP/${FILE%.tar.gz}/bin/node" "$NODE.new"
  mv -f "$NODE.new" "$NODE"
  say "     Node.js $VERSION is ready."
fi

# 2. gctk: the newest version from GitHub.
say "2/3  gctk"
if [ -n "${GCTK_INSTALL_FROM:-}" ]; then
  SRC="$GCTK_INSTALL_FROM" # a checkout or build of gctk (testing the installer)
else
  curl -fL --progress-bar -o "$TMP/gctk.tar.gz" "$REPO/archive/refs/heads/main.tar.gz" || fail "github.com could not be reached. Check the internet connection (or VPN) and try again."
  mkdir "$TMP/gctk"
  tar -xzf "$TMP/gctk.tar.gz" -C "$TMP/gctk"
  SRC="$(find "$TMP/gctk" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
fi
[ -f "$SRC/dist/gctk.js" ] || fail "GitHub's download holds no gctk."

# 3. The app to click, the gctk command and the first start.
say "3/3  Setting up $NAME"
"$NODE" "$SRC/dist/gctk.js" install --edition "$EDITION" || fail "the setup stopped (see the lines above)."

say ""
say "Done. $NAME opened in your browser."
if [ "$OS" = darwin ]; then
  say "Next time, open \"$NAME\" from Launchpad or Spotlight (it is in your Applications folder)."
else
  say "Next time, open \"$NAME\" from your applications menu."
fi
say "You can close this window."
