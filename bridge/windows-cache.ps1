# User-space cache only. Uses the installed AMD driver without altering it.
$cacheRoot = 'C:\Users\toryf\duckpond-worker\models'
New-Item -ItemType Directory -Force $cacheRoot | Out-Null
function Cache-File($asset, [string]$LeasePath) {
    if ($asset.cacheKey -notmatch '^[0-9a-f]{64}$' -or $asset.name -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Invalid model cache path' }
    $directory = Join-Path $cacheRoot $asset.cacheKey
    New-Item -ItemType Directory -Force $directory | Out-Null
    $destination = Join-Path $directory $asset.name
    $stamp = $destination + '.verified.json'
    if (Test-Path $destination) {
        $file = Get-Item $destination
        if ($file.Length -eq $asset.bytes -and (Test-Path $stamp)) {
            $verified = Get-Content $stamp -Raw | ConvertFrom-Json
            if ($verified.sha256 -eq $asset.sha256 -and $verified.mtimeTicks -eq $file.LastWriteTimeUtc.Ticks) {
                Write-Host ("cache_hit=" + $asset.name)
                return $destination
            }
        }
    }
    $partial = $destination + '.partial'
    $transfer = $null
    try {
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = 'C:\Windows\System32\curl.exe'
        $info.Arguments = '--fail --silent --show-error --max-time 1800 --output ' + $partial + ' ' + $asset.url
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $transfer = [Diagnostics.Process]::Start($info)
        while (-not $transfer.WaitForExit(5000)) {
            $lease = Invoke-RestMethod -Uri ('http://127.0.0.1:18083' + $LeasePath) -TimeoutSec 10
            if (-not $lease.allowed) { throw 'Fedora withdrew the worker lease' }
            Write-Host ("transfer_bytes=" + (Get-Item $partial).Length)
        }
        if ($transfer.ExitCode -ne 0 -or (Get-Item $partial).Length -ne $asset.bytes) { throw 'Incomplete model transfer' }
        $hash = (Get-FileHash $partial -Algorithm SHA256).Hash.ToLower()
        if ($hash -ne $asset.sha256) { throw 'Model SHA256 mismatch' }
        Move-Item -LiteralPath $partial -Destination $destination -Force
        @{ sha256=$hash; mtimeTicks=(Get-Item $destination).LastWriteTimeUtc.Ticks } | ConvertTo-Json -Compress | Set-Content $stamp
        Write-Host ("cache_stored=" + $asset.name)
        return $destination
    } finally {
        if ($transfer -and -not $transfer.HasExited) { $transfer.Kill(); $transfer.WaitForExit() }
        if (Test-Path $partial) { Remove-Item -LiteralPath $partial -Force }
    }
}
function Quote-Native([string]$value) {
    $value = [regex]::Replace($value, '(\\*)"', '$1$1\"')
    $value = [regex]::Replace($value, '(\\+)$', '$1$1')
    return '"' + $value + '"'
}
