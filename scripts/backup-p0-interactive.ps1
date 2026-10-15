param(
  [Parameter(Mandatory = $true)]
  [string]$PgBinDirectory,
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory,
  [Parameter(Mandatory = $true)]
  [string]$ProjectRef
)

$ErrorActionPreference = 'Stop'
$pgDump = Join-Path $PgBinDirectory 'pg_dump.exe'
$pgRestore = Join-Path $PgBinDirectory 'pg_restore.exe'
if (-not (Test-Path -LiteralPath $pgDump) -or -not (Test-Path -LiteralPath $pgRestore)) {
  throw 'PostgreSQL client tools are missing.'
}

$securePassword = Read-Host 'Nhap mat khau PostgreSQL (khong hien thi)' -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
$previousPath = $env:Path
try {
  $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  $env:P0_DATABASE_URL = "postgresql://postgres@db.$ProjectRef.supabase.co:5432/postgres?sslmode=require"
  $env:Path = "$PgBinDirectory;$previousPath"
  & (Join-Path $PSScriptRoot 'backup-p0-database.ps1') -OutputDirectory $OutputDirectory

  $archive = Get-ChildItem -LiteralPath $OutputDirectory -Filter '*.full.dump' |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if (-not $archive) { throw 'Backup archive not found.' }
  $archiveList = & $pgRestore --list $archive.FullName
  if ($LASTEXITCODE -ne 0 -or -not $archiveList) { throw 'pg_restore could not read the backup archive.' }
  Write-Output "Archive catalog verified: $($archive.Name)"
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:P0_DATABASE_URL -ErrorAction SilentlyContinue
  $env:Path = $previousPath
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
}
