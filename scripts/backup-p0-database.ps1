param(
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'

if (-not $env:P0_DATABASE_URL) {
  throw 'Set P0_DATABASE_URL to the Postgres connection string. Do not commit it.'
}
if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) {
  throw 'pg_dump is required. Install the PostgreSQL client matching the server major version.'
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$fullDump = Join-Path $resolvedOutput "weblendon-$stamp.full.dump"
$fullSql = Join-Path $resolvedOutput "weblendon-$stamp.full.sql"
$schemaDump = Join-Path $resolvedOutput "weblendon-$stamp.schema.sql"
$manifest = Join-Path $resolvedOutput "weblendon-$stamp.sha256"

& pg_dump --format=custom --no-owner --no-privileges --file=$fullDump $env:P0_DATABASE_URL
if ($LASTEXITCODE -ne 0) { throw 'Full pg_dump failed.' }

& pg_dump --format=plain --no-owner --no-privileges --file=$fullSql $env:P0_DATABASE_URL
if ($LASTEXITCODE -ne 0) { throw 'Full SQL pg_dump failed.' }

& pg_dump --schema-only --format=plain --no-owner --no-privileges --file=$schemaDump $env:P0_DATABASE_URL
if ($LASTEXITCODE -ne 0) { throw 'Schema pg_dump failed.' }

function Get-Sha256Hex([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

$fullHash = Get-Sha256Hex $fullDump
$fullSqlHash = Get-Sha256Hex $fullSql
$schemaHash = Get-Sha256Hex $schemaDump
@(
  "$fullHash  $([System.IO.Path]::GetFileName($fullDump))"
  "$fullSqlHash  $([System.IO.Path]::GetFileName($fullSql))"
  "$schemaHash  $([System.IO.Path]::GetFileName($schemaDump))"
) | Set-Content -LiteralPath $manifest -Encoding utf8

Write-Output "Backup created: $fullDump"
Write-Output "Full SQL created: $fullSql"
Write-Output "Schema created: $schemaDump"
Write-Output "Checksums: $manifest"
