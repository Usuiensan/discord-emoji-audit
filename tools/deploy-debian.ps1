[CmdletBinding()]
param(
  [Parameter(Mandatory)] [ValidatePattern('^[A-Za-z0-9.-]+$')] [string] $RemoteHost,
  [ValidatePattern('^[A-Za-z0-9_-]+$')] [string] $SshUser = 'emojiadmin',
  [ValidateRange(1, 65535)] [int] $Port = 22,
  [switch] $Rollback
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$ssh = Get-Command ssh -ErrorAction Stop
$scp = Get-Command scp -ErrorAction Stop
$target = "$SshUser@$RemoteHost"
$remoteHelper = '/usr/local/sbin/discord-emoji-audit-deploy'

Push-Location $projectRoot
try {
  if ($Rollback) {
    & $ssh.Source -T -p $Port -o StrictHostKeyChecking=yes $target "sudo -n $remoteHelper --rollback"
    if ($LASTEXITCODE) { throw '切り戻しに失敗しました。Debianのsystemdログを確認してください。' }
    return
  }

  if (git status --porcelain) { throw '未コミットの変更があります。コミットしてからデプロイしてください。' }
  git diff --check
  if ($LASTEXITCODE) { throw '差分の空白エラーがあります。' }
  Get-ChildItem src -Filter '*.js' | ForEach-Object { node --check $_.FullName }
  npm test
  if ($LASTEXITCODE) { throw 'ローカルテストに失敗しました。デプロイしません。' }

  $sha = (git rev-parse --verify HEAD).Trim()
  if ($sha -notmatch '^[0-9a-f]{40}$') { throw 'コミットIDを取得できません。' }
  $archive = Join-Path ([System.IO.Path]::GetTempPath()) "discord-emoji-audit-$sha.tar"
  $remoteArchive = "/tmp/discord-emoji-audit-$sha.tar"
  try {
    git archive --format=tar --output=$archive HEAD
    if ($LASTEXITCODE) { throw '配布アーカイブの作成に失敗しました。' }
    # Debian側でSFTPサブシステムが無効でも、従来のscp転送で配布できるようにする。
    & $scp.Source -O -P $Port -o StrictHostKeyChecking=yes $archive "${target}:$remoteArchive"
    if ($LASTEXITCODE) { throw '配布アーカイブの転送に失敗しました。' }
    & $ssh.Source -T -p $Port -o StrictHostKeyChecking=yes $target "sudo -n $remoteHelper --sha $sha --archive $remoteArchive"
    if ($LASTEXITCODE) { throw 'デプロイに失敗しました。旧版への自動切り戻し結果をDebianの出力で確認してください。' }
  } finally {
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  }
} finally {
  Pop-Location
}
