param([string]$Action = 'run', [string]$Payload = '')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$base = 'C:\Users\toryf\duckpond-worker'
$exe = Join-Path $base 'sd-runtime\sd-cli.exe'
. (Join-Path $base 'windows-cache.ps1')
if ($Action -eq 'stop') {
    Get-CimInstance Win32_Process -Filter "Name='sd-cli.exe'" | Where-Object { $_.ExecutablePath -eq $exe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    @{ stopped = $true } | ConvertTo-Json -Compress
    exit
}
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
$process = $null
$output = Join-Path $base ('image-' + $request.tag + '-%d.png')
try {
    $paths = @{}
    foreach ($asset in $request.assets) { $paths[$asset.role] = Cache-File $asset '/image-lease' }
    $arguments = @('--diffusion-model',$paths.diffusion,'--llm',$paths.encoder,'--vae',$paths.vae,'--backend','vulkan1','--max-vram','-0.5','--threads','12','--vae-tiling','--sampling-method','euler','--steps',[string]$request.steps,'--cfg-scale',[string]$request.cfg,'-W',[string]$request.width,'-H',[string]$request.height,'-b',[string]$request.n,'-s',[string]$request.seed,'-p',$request.prompt,'-o',$output)
    if ($request.tuning.paramsBackend -eq 'auto') { $arguments += @('--auto-fit','on') }
    else { $arguments += @('--params-backend','cpu') }
    if ($request.tuning.flashAll) { $arguments += '--fa' } else { $arguments += '--diffusion-fa' }
    if ($request.tuning.mmap) { $arguments += '--mmap' }
    if ($request.tuning.vaeTile) {
        if ([int]$request.tuning.vaeTile -notin @(256,512) -or [double]$request.tuning.vaeOverlap -notin @(0.25,0.5)) { throw 'Invalid VAE tile settings' }
        $arguments += @('--vae-tile-size',([string]$request.tuning.vaeTile+'x'+[string]$request.tuning.vaeTile),'--vae-tile-overlap',[string]$request.tuning.vaeOverlap)
    }
    if ($request.negative) { $arguments += @('-n',$request.negative) }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $exe
    $info.WorkingDirectory = Join-Path $base 'sd-runtime'
    $info.Arguments = ($arguments | ForEach-Object { Quote-Native ([string]$_) }) -join ' '
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    Write-Host 'image_phase=loading_windows_memory'
    $process = [Diagnostics.Process]::Start($info)
    $outTask = $process.StandardOutput.ReadLineAsync()
    $errTask = $process.StandardError.ReadLineAsync()
    $outClosed = $false
    $errClosed = $false
    $leaseClock = [Diagnostics.Stopwatch]::StartNew()
    while (-not $process.HasExited -or -not $outClosed -or -not $errClosed) {
        if (-not $outClosed -and $outTask.IsCompleted) {
            if ($null -eq $outTask.Result) { $outClosed = $true } else {
                [Console]::Out.WriteLine($outTask.Result)
                $outTask = $process.StandardOutput.ReadLineAsync()
            }
        }
        if (-not $errClosed -and $errTask.IsCompleted) {
            if ($null -eq $errTask.Result) { $errClosed = $true } else {
                [Console]::Out.WriteLine($errTask.Result)
                $errTask = $process.StandardError.ReadLineAsync()
            }
        }
        if ($leaseClock.Elapsed.TotalSeconds -ge 5) {
            $lease = Invoke-RestMethod -Uri 'http://127.0.0.1:18083/image-lease' -TimeoutSec 10
            if (-not $lease.allowed) { throw 'Image request cancelled or Fedora disconnected' }
            $leaseClock.Restart()
        }
        if (-not $process.HasExited) { $null = $process.WaitForExit(100) } else { Start-Sleep -Milliseconds 10 }
    }
    if ($process.ExitCode -ne 0) { throw "sd-cli exited $($process.ExitCode)" }
    $files = @(Get-ChildItem $base -Filter ('image-' + $request.tag + '-*.png') | Sort-Object Name)
    if (-not $files.Count) { throw 'Image engine did not create an output file' }
    $images = @($files | ForEach-Object { @{ b64_json = [Convert]::ToBase64String([IO.File]::ReadAllBytes($_.FullName)) } })
    $result = @{ data = $images; model_used = 'qwen-image-2.1'; steps_used = $request.steps; output_format = 'png' } | ConvertTo-Json -Depth 4 -Compress
    [Console]::Out.WriteLine('__DUCKPOND_RESULT__' + $result)
} finally {
    if ($process -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
    Get-ChildItem $base -Filter ('image-' + $request.tag + '-*.png') | Remove-Item -Force
    Write-Host 'image_worker_stopped_ram_vram_released_ssd_cache_retained'
}
