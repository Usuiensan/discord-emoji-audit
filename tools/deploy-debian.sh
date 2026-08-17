#!/usr/bin/env bash
set -Eeuo pipefail

BASE_DIR=/opt/discord-emoji-audit
RELEASES_DIR="$BASE_DIR/releases"
CURRENT_LINK="$BASE_DIR/current"
PREVIOUS_LINK="$BASE_DIR/previous"
SERVICE=discord-emoji-audit
RUN_USER=emoji-audit
LOCK_FILE=/run/lock/discord-emoji-audit-deploy.lock

sha=''
archive=''
rollback=false
while (($#)); do
  case "$1" in
    --sha) sha=${2:?}; shift 2 ;;
    --archive) archive=${2:?}; shift 2 ;;
    --rollback) rollback=true; shift ;;
    *) echo "不明な引数: $1" >&2; exit 2 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo 'root権限で実行してください。' >&2; exit 1; }
exec 9>"$LOCK_FILE"
flock -n 9 || { echo '別のデプロイまたは切り戻しが実行中です。' >&2; exit 1; }

release_path() {
  local path
  path=$(readlink -f "$1" 2>/dev/null || true)
  [[ $path == "$RELEASES_DIR"/* ]] && [[ -d $path ]] && printf '%s\n' "$path"
}

set_link() {
  local link=$1 target=$2 temporary="$1.new"
  ln -sfn "$target" "$temporary"
  mv -Tf "$temporary" "$link"
}

restart_or_restore() {
  local target=$1 previous=$2
  set_link "$CURRENT_LINK" "$target"
  if systemctl restart "$SERVICE" && sleep 3 && systemctl is-active --quiet "$SERVICE"; then
    [[ -n $previous ]] && set_link "$PREVIOUS_LINK" "$previous"
    echo "稼働中リリース: $(basename "$target")"
    return 0
  fi
  echo '新リリースの起動確認に失敗したため切り戻します。' >&2
  [[ -n $previous ]] || return 1
  set_link "$CURRENT_LINK" "$previous"
  systemctl restart "$SERVICE"
  sleep 3
  systemctl is-active --quiet "$SERVICE" || return 1
  echo "切り戻し完了: $(basename "$previous")" >&2
  return 1
}

if $rollback; then
  [[ -z $sha && -z $archive ]] || { echo '--rollbackは単独で指定してください。' >&2; exit 2; }
  previous=$(release_path "$PREVIOUS_LINK")
  current=$(release_path "$CURRENT_LINK")
  [[ -n $previous && -n $current ]] || { echo '切り戻せる旧リリースがありません。' >&2; exit 1; }
  restart_or_restore "$previous" "$current"
  exit $?
fi

[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo '不正なコミットIDです。' >&2; exit 2; }
[[ -r $archive ]] || { echo '配布アーカイブを読めません。' >&2; exit 2; }

mkdir -p "$RELEASES_DIR"
target="$RELEASES_DIR/$sha"
current=$(release_path "$CURRENT_LINK")
if [[ ! -d $target ]]; then
  temporary="$RELEASES_DIR/.${sha}.tmp.$$"
  trap 'rm -f "$archive"; rm -rf "$temporary"' EXIT
  mkdir "$temporary"
  tar -xf "$archive" -C "$temporary"
  [[ -f $temporary/package-lock.json ]] || { echo '配布アーカイブが不完全です。' >&2; exit 1; }
  (
    cd "$temporary"
    npm ci --omit=dev
    find src -type f -name '*.js' -print0 | xargs -0 -r -n1 node --check
    npm test
  )
  chown -R "$RUN_USER:$RUN_USER" "$temporary"
  mv "$temporary" "$target"
  trap - EXIT
fi

rm -f "$archive"
restart_or_restore "$target" "$current"
