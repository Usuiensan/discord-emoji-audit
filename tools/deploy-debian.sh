#!/usr/bin/env bash
# Install this file as /usr/local/sbin/discord-emoji-audit-deploy (root:root 0755).
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
    --sha)
      (($# >= 2)) || { echo '--shaには値が必要です。' >&2; exit 2; }
      sha=$2
      shift 2
      ;;
    --archive)
      (($# >= 2)) || { echo '--archiveには値が必要です。' >&2; exit 2; }
      archive=$2
      shift 2
      ;;
    --rollback)
      rollback=true
      shift
      ;;
    *) echo "不明な引数: $1" >&2; exit 2 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo 'root権限で実行してください。' >&2; exit 1; }
exec 9>"$LOCK_FILE"
flock -n 9 || { echo '別のデプロイまたは切り戻しが実行中です。' >&2; exit 1; }

release_path() {
  local path
  path=$(readlink -f -- "$1" 2>/dev/null || true)
  [[ $path == "$RELEASES_DIR"/* ]] || return 1
  [[ $(basename "$path") =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ -d $path && ! -L $path ]] || return 1
  printf '%s\n' "$path"
}

set_link() {
  local link=$1 target=$2 temporary="${1}.new"
  ln -sfn -- "$target" "$temporary"
  mv -Tf -- "$temporary" "$link"
}

current_release() {
  local current=''
  if [[ -e $CURRENT_LINK || -L $CURRENT_LINK ]]; then
    current=$(release_path "$CURRENT_LINK" || true)
    if [[ -z $current ]]; then
      echo "currentは管理対象外のリンクまたはディレクトリです。初回デプロイとして扱います: $CURRENT_LINK" >&2
    fi
  else
    echo "currentは未設定です。初回デプロイとして扱います: $CURRENT_LINK" >&2
  fi
  printf '%s\n' "$current"
}

validate_archive() {
  local listing member line type
  listing=$(tar -tf "$archive") || { echo '配布アーカイブの一覧を読めません。' >&2; return 1; }
  while IFS= read -r member; do
    [[ -n $member ]] || continue
    [[ $member != /* ]] || { echo "絶対パスを含むアーカイブです: $member" >&2; return 1; }
    case "/$member/" in
      */../*) echo "展開先外を指すパスを含むアーカイブです: $member" >&2; return 1 ;;
    esac
  done <<< "$listing"

  listing=$(tar -tvf "$archive") || { echo '配布アーカイブの詳細を読めません。' >&2; return 1; }
  while IFS= read -r line; do
    [[ -n $line ]] || continue
    type=${line:0:1}
    [[ $type != l && $type != h ]] || { echo 'symlink/hardlinkを含むアーカイブは拒否します。' >&2; return 1; }
  done <<< "$listing"
}

restore_original_current() {
  local original=$1
  if [[ -n $original ]]; then
    set_link "$CURRENT_LINK" "$original"
  else
    rm -f -- "$CURRENT_LINK"
  fi
}

restart_or_restore() {
  local target=$1 previous=$2 original_current=$3
  set_link "$CURRENT_LINK" "$target"
  if systemctl restart "$SERVICE" && sleep 3 && systemctl is-active --quiet "$SERVICE"; then
    [[ -n $previous ]] && set_link "$PREVIOUS_LINK" "$previous"
    echo "稼働中リリース: $(basename "$target")"
    return 0
  fi

  echo '新リリースの起動確認に失敗したため切り戻します。' >&2
  if [[ -n $previous ]]; then
    set_link "$CURRENT_LINK" "$previous"
    systemctl restart "$SERVICE"
    sleep 3
    systemctl is-active --quiet "$SERVICE" || { echo '旧リリースの再起動にも失敗しました。' >&2; return 1; }
    echo "切り戻し完了: $(basename "$previous")" >&2
  else
    restore_original_current "$original_current"
    echo '切り戻せる管理対象リリースがないため、元のcurrentを復元しました。' >&2
  fi
  return 1
}

if $rollback; then
  [[ -z $sha && -z $archive ]] || { echo '--rollbackは単独で指定してください。' >&2; exit 2; }
  current=$(release_path "$CURRENT_LINK" || true)
  previous=$(release_path "$PREVIOUS_LINK" || true)
  [[ -n $current && -n $previous ]] || { echo 'currentまたはpreviousに管理対象リリースがありません。' >&2; exit 1; }
  restart_or_restore "$previous" "$current" "$(readlink -- "$CURRENT_LINK")"
  exit $?
fi

[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo '不正なコミットIDです。' >&2; exit 2; }
expected_archive="/tmp/discord-emoji-audit-$sha.tar"
[[ $archive == "$expected_archive" ]] || { echo "アーカイブは $expected_archive のみ許可します。" >&2; exit 2; }
[[ -f $archive && ! -L $archive && -r $archive ]] || { echo '配布アーカイブを読めません。' >&2; exit 2; }
validate_archive

mkdir -p -- "$RELEASES_DIR"
target="$RELEASES_DIR/$sha"
current=$(current_release)
original_current=$(readlink -- "$CURRENT_LINK" 2>/dev/null || true)
if [[ -e $target || -L $target ]]; then
  [[ -d $target && ! -L $target ]] || { echo '同名リリースがディレクトリではありません。' >&2; exit 1; }
else
  temporary="$RELEASES_DIR/.${sha}.tmp.$$"
  trap 'rm -f -- "$archive"; rm -rf -- "$temporary"' EXIT
  mkdir -- "$temporary"
  tar --no-same-owner --no-same-permissions -xf "$archive" -C "$temporary"
  [[ -z $(find "$temporary" -type l -print -quit) ]] || { echo '展開後に不正なリンクを検出しました。' >&2; exit 1; }
  [[ -f $temporary/package-lock.json ]] || { echo '配布アーカイブが不完全です。' >&2; exit 1; }
  chown -R "$RUN_USER:$RUN_USER" "$temporary"
  runuser -u "$RUN_USER" -- bash -c 'set -Eeuo pipefail; cd "$1"; npm ci --omit=dev; find src -type f -name "*.js" -print0 | xargs -0 -r -n1 node --check; npm test' -- "$temporary"
  mv -- "$temporary" "$target"
  trap - EXIT
fi

rm -f -- "$archive"
restart_or_restore "$target" "$current" "$original_current"
