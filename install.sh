#!/usr/bin/env sh
# dsh-qwen-image 一键安装（Linux / macOS）
# 用法：sh install.sh [--check|--dry-run|--yes|...]
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[X] 没有找到 Node.js 18+：本安装器和 dsh 都依赖它。"
  echo "    安装：https://nodejs.org/en/download 或系统包管理器（apt/dnf/brew install node）"
  exit 1
fi

exec node installer/install.mjs "$@"
