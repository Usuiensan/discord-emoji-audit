#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf -- "$test_dir"; rm -f -- /tmp/discord-emoji-audit-*.tar' EXIT

base="$test_dir/app"
bin="$test_dir/bin"
state="$test_dir/state"
helper="$test_dir/helper"
mkdir -p "$bin" "$state"
cp "$root/tools/deploy-debian.sh" "$helper"
test_user=$(id -un)
test_group=$(id -gn)
sed -i \
  -e "s|^BASE_DIR=.*|BASE_DIR=$base|" \
  -e "s|^LOCK_FILE=.*|LOCK_FILE=$test_dir/deploy.lock|" \
  -e "s|^RUN_USER=.*|RUN_USER=$test_user|" \
  -e "s|^\[\[ \$EUID -eq 0 \]\].*|true|" \
  -e 's/sleep 3/sleep 0/g' \
  -e "s|chown -R \"\$RUN_USER:\$RUN_USER\" \"\$temporary\"|chown -R $test_user:$test_group \"\$temporary\"|" \
  "$helper"

cat > "$bin/systemctl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
state=${DEPLOY_TEST_STATE:?}
case "$1" in
  restart)
    if [[ -f "$state/fail-once" ]]; then
      rm -f "$state/fail-once"
      exit 1
    fi
    touch "$state/active"
    ;;
  is-active)
    [[ -f "$state/active" ]]
    ;;
  *) exit 2 ;;
esac
EOF
cat > "$bin/runuser" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
while [[ ${1:-} != -- ]]; do shift; done
shift
exec "$@"
EOF
cat > "$bin/npm" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${1:-}" in
  ci|test) exit 0 ;;
  *) exit 2 ;;
esac
EOF
cat > "$bin/node" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ ${1:-} == --check ]] || exit 2
EOF
chmod +x "$bin/systemctl" "$bin/runuser" "$bin/npm" "$bin/node" "$helper"
export DEPLOY_TEST_STATE="$state"
export PATH="$bin:$PATH"

make_archive() {
  local sha=$1 source="$test_dir/source-$1"
  mkdir -p "$source/src"
  printf '{}\n' > "$source/package-lock.json"
  printf 'export default true;\n' > "$source/src/index.js"
  tar -cf "/tmp/discord-emoji-audit-$sha.tar" -C "$source" .
}

assert_link() {
  local name=$1 expected=$2
  [[ $(readlink "$base/$name") == "$expected" ]] || { echo "$nameのリンクが期待値と異なります。" >&2; exit 1; }
}

sha1=1111111111111111111111111111111111111111
sha2=2222222222222222222222222222222222222222
sha3=3333333333333333333333333333333333333333
mkdir -p "$base"
ln -s /app "$base/current"
make_archive "$sha1"
"$helper" --sha "$sha1" --archive "/tmp/discord-emoji-audit-$sha1.tar"
assert_link current "$base/releases/$sha1"
[[ ! -e /tmp/discord-emoji-audit-$sha1.tar ]] || exit 1

make_archive "$sha2"
"$helper" --sha "$sha2" --archive "/tmp/discord-emoji-audit-$sha2.tar"
assert_link current "$base/releases/$sha2"
assert_link previous "$base/releases/$sha1"

make_archive "$sha3"
touch "$state/fail-once"
if "$helper" --sha "$sha3" --archive "/tmp/discord-emoji-audit-$sha3.tar"; then
  echo '起動失敗を成功扱いしました。' >&2
  exit 1
fi
assert_link current "$base/releases/$sha2"
assert_link previous "$base/releases/$sha1"

"$helper" --rollback
assert_link current "$base/releases/$sha1"
assert_link previous "$base/releases/$sha2"
echo 'deploy-debian: 初回、通常更新、起動失敗rollback、手動rollback OK'
