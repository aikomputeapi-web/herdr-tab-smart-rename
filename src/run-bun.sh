#!/bin/sh
set -eu

bun_path=$(command -v bun 2>/dev/null || true)
if [ -n "$bun_path" ] && [ -x "$bun_path" ]; then
  exec "$bun_path" "$@"
fi

if [ -n "${HOME:-}" ] && [ -x "$HOME/.bun/bin/bun" ]; then
  exec "$HOME/.bun/bin/bun" "$@"
fi

for cand in "$USERPROFILE/.bun/bin/bun.exe" "/c/Users/Administrator/.bun/bin/bun.exe" "C:/Users/Administrator/.bun/bin/bun.exe"; do
  if [ -n "${cand:-}" ] && [ -x "$cand" ]; then
    exec "$cand" "$@"
  fi
done

for bun_path in /opt/homebrew/bin/bun /usr/local/bin/bun /home/linuxbrew/.linuxbrew/bin/bun; do
  if [ -x "$bun_path" ]; then
    exec "$bun_path" "$@"
  fi
done

printf '%s\n' 'Smart Rename: Bun not found; install Bun or add it to the Herdr server PATH' >&2
exit 127
