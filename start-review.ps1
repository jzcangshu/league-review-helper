$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Join-Path $root 'review-web'
$portFile = Join-Path ([System.IO.Path]::GetTempPath()) 'review-web-port.json'
$fallbackPortFile = Join-Path $serverDir 'review-web-port.txt'
$stdoutLog = Join-Path $serverDir 'start-review-output.log'
$stderrLog = Join-Path $serverDir 'start-review-error.log'

function Show-ServerLogs {
  if (Test-Path -LiteralPath $stderrLog) {
    Write-Host "服务错误日志：$stderrLog" -ForegroundColor Yellow
    Get-Content -LiteralPath $stderrLog -Tail 80
  }
  if (Test-Path -LiteralPath $stdoutLog) {
    Write-Host "服务运行日志：$stdoutLog" -ForegroundColor Yellow
    Get-Content -LiteralPath $stdoutLog -Tail 40
  }
}

function Get-HealthyPort {
  foreach ($candidate in @($fallbackPortFile, $portFile)) {
    if (-not (Test-Path -LiteralPath $candidate)) {
      continue
    }

    try {
      $raw = (Get-Content -LiteralPath $candidate -Raw).Trim()
      $parsed = $raw | ConvertFrom-Json
      $port = [int]$parsed.port
      if (-not $port) {
        continue
      }

      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2
      if ($health.ok -and ([System.IO.Path]::GetFullPath($health.workspaceRoot) -eq [System.IO.Path]::GetFullPath($root))) {
        return $port
      }
    } catch {
      continue
    }
  }
  return $null
}

$existingPort = Get-HealthyPort
if ($existingPort) {
  Start-Process "http://127.0.0.1:$existingPort"
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw '未找到 Node.js（节点运行环境）。请先安装 Node.js 18 或更高版本。'
}

$requiredModules = @(
  (Join-Path $serverDir 'node_modules\exceljs'),
  (Join-Path $serverDir 'node_modules\pdfjs-dist')
)
$missingDependencies = $requiredModules | Where-Object { -not (Test-Path -LiteralPath $_) }

if ($missingDependencies) {
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCommand) {
    throw '首次启动需要安装网页依赖，但未找到 npm（包管理工具）。请重新安装完整的 Node.js。'
  }

  Write-Host '首次启动正在准备审核工具，请稍候……' -ForegroundColor Cyan
  Push-Location $serverDir
  try {
    & $npmCommand.Source install --omit=dev --no-audit --no-fund
    $npmExitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($npmExitCode -ne 0) {
    throw '依赖安装失败，请检查网络后重新双击启动。'
  }
}

Write-Host '正在启动审核软件……' -ForegroundColor Cyan
$process = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $serverDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
$deadline = (Get-Date).AddSeconds(20)
$port = $null

while (-not $port -and (Get-Date) -lt $deadline) {
  if ($process.HasExited) {
    Show-ServerLogs
    throw "审核工具启动失败，详细日志保存在：$stderrLog"
  }

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
  $port = Get-HealthyPort
}
if (-not $port) {
  Show-ServerLogs
  throw '审核工具启动超时，请关闭后重新双击启动。'
}

Write-Host "启动成功：http://127.0.0.1:$port" -ForegroundColor Green
Start-Process "http://127.0.0.1:$port"
