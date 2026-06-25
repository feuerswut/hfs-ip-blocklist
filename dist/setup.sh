#!/bin/sh
# Compile the roaring bitmap native addon from source.
# Run this once on platforms without a prebuilt binary (e.g. 32-bit ARM / Raspberry Pi).
#
# Prerequisites:
#   node, npm, python3, make, gcc / g++  (on Raspberry Pi OS: sudo apt install build-essential)
#
# Usage (run from the plugin directory):
#   sh setup.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"

echo "[setup] Building roaring native addon in: $BUILD_DIR"
cd "$BUILD_DIR"
npm install
echo "[setup] Done. Restart HFS to activate the roaring bitmap backend."
