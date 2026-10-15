# One-time SoViet production migration. The password is never placed on the
# command line, in a URL, or in a file.
$ErrorActionPreference = 'Stop'

$projectRef = 'coebrkerpcgwckkwxlfo'
$pgBinDirectory = Join-Path $env:TEMP 'pg17-client\pgsql\bin'
$backupDirectory = 'D:\Desktop\soviet-backups\20261015-before-0090'
$migrationPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'migrations\0090_bounded_customer_product_lookup.sql'
$psql = Join-Path $pgBinDirectory 'psql.exe'
$pgRestore = Join-Path $pgBinDirectory 'pg_restore.exe'
if (-not (Test-Path -LiteralPath $psql) -or -not (Test-Path -LiteralPath $pgRestore)) {
  throw 'PostgreSQL 17 client tools are missing.'
}
if (-not (Test-Path -LiteralPath $migrationPath)) { throw 'Migration 0090 is missing.' }

$manifest = Get-ChildItem -LiteralPath $backupDirectory -Filter '*.sha256' |
  Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not $manifest) { throw 'Verified pre-migration backup is missing.' }
$verifiedNames = @()
foreach ($line in [System.IO.File]::ReadAllLines($manifest.FullName)) {
  if ($line -notmatch '^([0-9a-f]{64})  ([\w.-]+)$') { throw 'Invalid backup checksum manifest.' }
  $expectedHash = $Matches[1]
  $fileName = $Matches[2]
  $filePath = Join-Path $backupDirectory $fileName
  if (-not (Test-Path -LiteralPath $filePath)) { throw "Backup file missing: $fileName" }
  if ((Get-Item -LiteralPath $filePath).Length -eq 0) { throw "Backup file empty: $fileName" }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $filePath).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw "Backup checksum mismatch: $fileName"
  }
  $verifiedNames += $fileName
}
$archiveName = $verifiedNames | Where-Object { $_ -like '*.full.dump' } | Select-Object -First 1
if (-not $archiveName -or -not ($verifiedNames | Where-Object { $_ -like '*.full.sql' }) -or
    -not ($verifiedNames | Where-Object { $_ -like '*.schema.sql' })) {
  throw 'Backup must contain custom, full SQL, and schema SQL copies.'
}
$archiveList = & $pgRestore --list (Join-Path $backupDirectory $archiveName)
if ($LASTEXITCODE -ne 0 -or -not $archiveList) { throw 'Backup archive catalog is unreadable.' }
Write-Output 'Backup checksums and archive catalog verified.'

$securePassword = Read-Host 'Nhap mat khau PostgreSQL moi (khong hien thi)' -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  $connection = "postgresql://postgres@db.$projectRef.supabase.co:5432/postgres?sslmode=require"
  $preflightSql = @'
SELECT CASE WHEN
  (SELECT count(*) FROM public.schema_migrations WHERE version IN ('0088', '0089')) = 2
  AND NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0090')
  AND to_regprocedure('public.rpc_egress_search_customers(text,integer,text,text)') IS NULL
THEN 'ready' ELSE 'stop' END;
'@
  $preflight = & $psql --no-psqlrc --tuples-only --no-align --dbname=$connection --command=$preflightSql
  if ($LASTEXITCODE -ne 0 -or ($preflight | Out-String).Trim() -ne 'ready') {
    throw 'Production migration preflight failed. No SQL was applied.'
  }
  Write-Output 'Production preflight passed; applying migration 0090.'
  & $psql --no-psqlrc --set=ON_ERROR_STOP=1 --dbname=$connection --file=$migrationPath
  if ($LASTEXITCODE -ne 0) { throw 'Migration 0090 failed. Its transaction should have rolled back.' }

  $verifySql = @'
SELECT CASE WHEN
  (SELECT count(*) FROM public.schema_migrations WHERE version = '0090') = 1
  AND to_regprocedure('public.rpc_egress_search_customers(text,integer,text,text)') IS NOT NULL
  AND to_regprocedure('public.rpc_egress_search_products(text,integer,text,text,boolean)') IS NOT NULL
  AND to_regprocedure('public.rpc_egress_product_family(text,integer,text)') IS NOT NULL
THEN 'verified' ELSE 'failed' END;
'@
  $verification = & $psql --no-psqlrc --tuples-only --no-align --dbname=$connection --command=$verifySql
  if ($LASTEXITCODE -ne 0 -or ($verification | Out-String).Trim() -ne 'verified') {
    throw 'Migration verification failed; inspect production before releasing the frontend.'
  }
  Write-Output 'Migration 0090 verified on production.'
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
}
