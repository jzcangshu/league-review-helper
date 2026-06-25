$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Join-Path $root 'review-web'
$portFile = Join-Path ([System.IO.Path]::GetTempPath()) 'review-web-port.json'
$fallbackPortFile = Join-Path $serverDir 'review-web-port.txt'

$process = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $serverDir -WindowStyle Hidden -PassThru

$deadline = (Get-Date).AddSeconds(15)
$port = $null

while (-not $port -and (Get-Date) -lt $deadline) {
  $listener = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -eq $process.Id -and $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::1', '::') } |
    Select-Object -First 1

  if ($listener) {
    $port = $listener.LocalPort
    break
  }

  Start-Sleep -Milliseconds 200
}

if (-not $port) {
  foreach ($candidate in @($portFile, $fallbackPortFile)) {
    if (-not (Test-Path $candidate)) {
      continue
    }

    $raw = (Get-Content $candidate -Raw).Trim()
    try {
      $parsed = $raw | ConvertFrom-Json
      if ($parsed.pid -eq $process.Id -and $parsed.port) {
        $port = [int]$parsed.port
        break
      }
    } catch {
      if ($raw -match '^\d+$') {
        $port = [int]$raw
        break
      }
    }
  }
}

if (-not $port) {
  throw '审核工具启动失败：未能确认监听端口。'
}

Start-Process "http://127.0.0.1:$port"
