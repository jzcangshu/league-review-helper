$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Join-Path $root 'review-web'
$portFile = Join-Path ([System.IO.Path]::GetTempPath()) 'review-web-port.json'
$fallbackPortFile = Join-Path $serverDir 'review-web-port.txt'

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
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw '首次启动需要安装网页依赖，但未找到 npm（包管理工具）。请重新安装完整的 Node.js。'
  }

  Write-Host '首次启动正在准备审核工具，请稍候……' -ForegroundColor Cyan
  & npm install --omit=dev --prefix $serverDir
  if ($LASTEXITCODE -ne 0) {
    throw '依赖安装失败，请检查网络后重新双击启动。'
  }
}

$process = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $serverDir -WindowStyle Hidden -PassThru
$deadline = (Get-Date).AddSeconds(20)
$port = $null

while (-not $port -and (Get-Date) -lt $deadline) {
  if ($process.HasExited) {
    throw '审核工具启动失败，请在 review-web 文件夹中运行 npm start 查看错误信息。'
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
  throw '审核工具启动超时，请关闭后重新双击启动。'
}

Start-Process "http://127.0.0.1:$port"
