#!/usr/bin/env bash
# Spike 06: the scratch project `e2e/drive.ts STEP=files` runs against — this
# repo's docs and sources plus everything the shared set must keep out:
# a tracked .env, a key, ignored dirs, a binary, a file over 1 MiB, and
# symlinks to /etc and to .env.
#
#   bash spikes/06-files-scratch-repo.sh [/tmp/canvas-demo]
#   bun src/cli.ts serve --dir /tmp/canvas-demo …
set -euo pipefail
dir=${1:-/tmp/canvas-demo}
repo=$(cd "$(dirname "$0")/.." && pwd)
rm -rf "$dir" && mkdir -p "$dir"
git -C "$repo" archive HEAD src docs e2e package.json | tar -x -C "$dir"
cd "$dir"
printf 'node_modules/\ndist/\n*.log\n' > .gitignore
printf 'API_KEY=sk-live-secret\n' > .env
printf 'API_KEY=\n' > .env.example
mkdir -p dist node_modules/pkg certs
printf 'console.log("built")\n' > dist/bundle.js
printf 'module.exports = 1\n' > node_modules/pkg/index.js
printf -- '-----BEGIN PRIVATE KEY-----\n' > certs/server.key
printf 'debug\n' > debug.log
head -c 4096 /dev/urandom > logo.png
seq 0 59999 | sed 's/.*/const line& = &;/' > big.ts
seq 0 7999 | sed 's/.*/export const value& = "&";/' > src/generated.ts
ln -sf /etc etc-link
ln -sf .env env-link.md
git init -q && git add -A && git -c user.email=demo@example.com -c user.name=demo commit -qm init
echo "scratch repo at $dir: $(git ls-files | wc -l) tracked files"
