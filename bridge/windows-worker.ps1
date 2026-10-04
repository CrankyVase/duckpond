param([string]$Action = 'run', [string]$Payload = '')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$base = 'C:\Users\toryf\duckpond-worker'
$exe = Join-Path $base 'runtime\llama-server.exe'
$model = Join-Path $base 'active-model.gguf'
$pidFile = Join-Path $base 'worker.pid'
. (Join-Path $base 'windows-cache.ps1')
if ($Action -eq 'hardware') {
    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = Get-CimInstance Win32_Processor
    $cpuUsage = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
    $adapters = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory)
    $gpu = $adapters | Sort-Object DedicatedUsage -Descending | Select-Object -First 1
    # Vulkan reports 16304 MiB of device-local memory on this RX 9070 XT.
    @{ host = 'Windows MR_PC'; sampledAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); gpuName = 'AMD Radeon RX 9070 XT'; cpuName = $cpu.Name; cpuCores = $cpu.NumberOfLogicalProcessors; cpuPercent = $cpuUsage.PercentProcessorTime; ram = @{ totalBytes = [long]$os.TotalVisibleMemorySize * 1024; availableBytes = [long]$os.FreePhysicalMemory * 1024; usedBytes = ([long]$os.TotalVisibleMemorySize - [long]$os.FreePhysicalMemory) * 1024 }; vram = @{ totalBytes = [long]16304 * 1024 * 1024; usedBytes = [long]$gpu.DedicatedUsage; host = 'Windows MR_PC'; name = 'AMD Radeon RX 9070 XT' } } | ConvertTo-Json -Depth 4 -Compress
    exit
}
function Stop-Worker {
    # Only terminate Duck Pond's executable, never another application's model.
    Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Where-Object { $_.ExecutablePath -eq $exe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
if ($Action -eq 'stop') {
    Stop-Worker
    # The run wrapper removes the temporary GGUF in its finally block.
    for ($i = 0; $i -lt 30 -and (Test-Path $pidFile); $i++) { Start-Sleep -Milliseconds 200 }
    if (-not (Test-Path $pidFile) -and (Test-Path $model)) { Remove-Item -LiteralPath $model -Force }
    @{ stopped = -not [bool](Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Where-Object { $_.ExecutablePath -eq $exe }); temporaryModelPresent = Test-Path $model } | ConvertTo-Json -Compress
    exit
}
if ($Action -eq 'status') {
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Where-Object { $_.ExecutablePath -eq $exe })
    $rss = 0
    foreach ($p in $processes) { $rss += (Get-Process -Id $p.ProcessId).WorkingSet64 }
    $cached = @(Get-ChildItem $cacheRoot -File -Recurse | Where-Object { $_.Name -notlike '*.json' -and $_.Name -notlike '*.partial' })
    @{ processes = $processes.Count; workingSetBytes = $rss; cachedFiles = $cached.Count; cachedBytes = ($cached | Measure-Object Length -Sum).Sum; temporaryModelPresent = Test-Path $model; temporaryModelBytes = $(if (Test-Path $model) { (Get-Item $model).Length } else { 0 }) } | ConvertTo-Json -Compress
    exit
}
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
if ($Action -eq 'delete') {
    foreach ($key in $request.keys) {
        if ($key -notmatch '^[0-9a-f]{64}$') { throw 'Invalid cache key' }
        $directory = Join-Path $cacheRoot $key
        if (Test-Path $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }
    }
    @{ deleted = @($request.keys) } | ConvertTo-Json -Compress
    exit
}
if ($Action -ne 'run') { throw 'Unknown action' }
$process = $null
$modelPath = $null
$transfer = $null
$stopwatch = [Diagnostics.Stopwatch]::StartNew()
try {
    foreach ($asset in $request.assets) { $cachedPath = Cache-File $asset '/lease'; if (-not $modelPath) { $modelPath = $cachedPath } }
    Write-Output ("cache_ready_seconds=" + $stopwatch.Elapsed.TotalSeconds)
    $tuning = $request.tuning
    $threads = 12; $threadsBatch = 12; $fitMargin = 512; $specType = 'none'
    # Match the native defaults; per-model profiles can tune prompt batching
    # independently without changing context, weight precision or sampling.
    $batchSize = 2048; $ubatchSize = 512
    if ($tuning) {
        if ([int]$tuning.threads -lt 1 -or [int]$tuning.threads -gt 24 -or [int]$tuning.threadsBatch -lt 1 -or [int]$tuning.threadsBatch -gt 24) { throw 'Invalid thread count' }
        if ([int]$tuning.fitMargin -notin @(256,512,768,1024)) { throw 'Invalid VRAM reserve' }
        if ($tuning.specType -notin @('none','ngram-simple','ngram-map-k','ngram-map-k4v','ngram-mod','ngram-cache','draft-mtp')) { throw 'Invalid speculative mode' }
        $threads = [int]$tuning.threads; $threadsBatch = [int]$tuning.threadsBatch; $fitMargin = [int]$tuning.fitMargin; $specType = $tuning.specType
        if ($null -ne $tuning.batchSize) {
            if ($tuning.batchSize -notin @(128,256,512,1024,2048,4096,8192)) { throw 'Invalid logical batch size' }
            $batchSize = [int]$tuning.batchSize
        }
        if ($null -ne $tuning.ubatchSize) {
            if ($tuning.ubatchSize -notin @(128,256,512,1024,2048,4096,8192)) { throw 'Invalid physical batch size' }
            $ubatchSize = [int]$tuning.ubatchSize
        }
    }
    if ($ubatchSize -gt $batchSize) { throw 'Physical batch size exceeds logical batch size' }
    $arguments = @('-m', $modelPath, '--alias', $request.model, '--host','127.0.0.1','--port','18082','--ctx-size','32768','--parallel','1','--n-gpu-layers','auto','--fit','on','--fit-ctx','32768','--fit-target',[string]$fitMargin,'--device','Vulkan1','--threads',[string]$threads,'--threads-batch',[string]$threadsBatch,'--flash-attn','on','--cache-type-k','q8_0','--cache-type-v','q8_0','--jinja','--spec-type',$specType,'--verbosity','3')
    $arguments += @('--batch-size',[string]$batchSize,'--ubatch-size',[string]$ubatchSize)
    if ($tuning.cpuMask) {
        if ($tuning.cpuMask -notmatch '^[0-9a-fA-F]{1,6}$') { throw 'Invalid CPU affinity mask' }
        $arguments += @('--cpu-mask',$tuning.cpuMask,'--cpu-strict','1')
    }
    if ($null -ne $tuning.opOffload -and -not $tuning.opOffload) { $arguments += '--no-op-offload' }
    if ($tuning.cpuFfn) {
        if ([int]$tuning.cpuFfn -lt 0 -or [int]$tuning.cpuFfn -gt 64) { throw 'Invalid CPU FFN layer count' }
        $arguments += @('--n-cpu-ffn',[string]$tuning.cpuFfn)
    }
    if ($specType -eq 'draft-mtp') {
        # Reuse this GGUF's trained MTP head rather than loading duplicate weights.
        $draftMax = 3
        if ($tuning.specDraftMax) { $draftMax = [int]$tuning.specDraftMax }
        if ($draftMax -notin @(1,2,3,4,6,8)) { throw 'Invalid MTP draft length' }
        $arguments += @('--spec-draft-n-max',[string]$draftMax)
    }
    $process = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory (Join-Path $base 'runtime') -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $base 'llama.stdout.log') -RedirectStandardError (Join-Path $base 'llama.stderr.log')
    $null = $process.Handle
    [IO.File]::WriteAllText($pidFile, [string]$process.Id)
    while (-not $process.WaitForExit(5000)) {
        $lease = Invoke-RestMethod -Uri 'http://127.0.0.1:18083/lease' -TimeoutSec 10
        if (-not $lease.allowed) { break }
    }
    if ($process.HasExited -and $process.ExitCode -ne 0) {
        $lease = Invoke-RestMethod -Uri 'http://127.0.0.1:18083/lease' -TimeoutSec 10 -ErrorAction SilentlyContinue
        if ($lease.allowed) { throw "llama-server exited $($process.ExitCode)" }
    }
} finally {
    if ($transfer -and -not $transfer.HasExited) { Stop-Process -Id $transfer.Id -Force -ErrorAction SilentlyContinue; $transfer.WaitForExit() }
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue; $process.WaitForExit() }
    if (Test-Path $model) { Remove-Item -LiteralPath $model -Force }
    if (Test-Path $pidFile) { Remove-Item -LiteralPath $pidFile -Force }
    Write-Output 'worker_stopped_ram_vram_released_ssd_cache_retained'
}
