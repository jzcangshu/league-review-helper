$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Join-Path $root 'review-web'
$portFile = Join-Path ([System.IO.Path]::GetTempPath()) 'review-web-port.json'
$fallbackPortFile = Join-Path $serverDir 'review-web-port.txt'
$stdoutLog = Join-Path $serverDir 'start-review-output.log'
$stderrLog = Join-Path $serverDir 'start-review-error.log'
$runtimeRoot = Join-Path $serverDir '.runtime'
$downloadRoot = Join-Path $runtimeRoot 'downloads'
$nodeVersion = '22.19.0'
$pythonVersion = '3.11.9'
$nodeFolderName = "node-v$nodeVersion-win-x64"
$nodeRuntimeRoot = Join-Path $runtimeRoot $nodeFolderName
$pythonRuntimeRoot = Join-Path $runtimeRoot "python-$pythonVersion"

function Invoke-RuntimeDownload {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$Label,
    [switch]$Force
  )

  if ((Test-Path -LiteralPath $Destination) -and -not $Force) {
    Write-Host "继续使用已下载的$Label。" -ForegroundColor DarkGray
    return
  }
  New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
  $partial = "$Destination.download"
  Write-Host "正在下载$Label，请保持网络连接……" -ForegroundColor Cyan
  $oldProgress = $ProgressPreference
  try {
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Uri -OutFile $partial -UseBasicParsing
    Move-Item -LiteralPath $partial -Destination $Destination -Force
  } catch {
    throw "$Label 下载失败：$($_.Exception.Message)"
  } finally {
    $ProgressPreference = $oldProgress
  }
}

function Test-NodeRuntime {
  param([string]$NodePath)
  if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath)) { return $false }
  try {
    $value = (& $NodePath --version 2>$null | Select-Object -First 1).Trim().TrimStart('v')
    return ([version]$value).Major -ge 18
  } catch {
    return $false
  }
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$FilePath)
  $stream = [System.IO.File]::OpenRead($FilePath)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Get-NodeRuntime {
  $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($systemNode -and (Test-NodeRuntime $systemNode.Source)) {
    $npmPath = Join-Path (Split-Path -Parent $systemNode.Source) 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npmPath)) {
      $systemNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
      if ($systemNpm) { $npmPath = $systemNpm.Source }
    }
    if (Test-Path -LiteralPath $npmPath) {
      return [pscustomobject]@{ Node = $systemNode.Source; Npm = $npmPath; Bundled = $false }
    }
  }

  $nodeExe = Join-Path $nodeRuntimeRoot 'node.exe'
  $npmCmd = Join-Path $nodeRuntimeRoot 'npm.cmd'
  if ((Test-NodeRuntime $nodeExe) -and (Test-Path -LiteralPath $npmCmd)) {
    return [pscustomobject]@{ Node = $nodeExe; Npm = $npmCmd; Bundled = $true }
  }

  Write-Host '未检测到可用的 Node.js 18+，将自动准备本地运行环境。' -ForegroundColor Yellow
  $nodeZipName = "$nodeFolderName.zip"
  $nodeZip = Join-Path $downloadRoot $nodeZipName
  $checksumFile = Join-Path $downloadRoot "node-v$nodeVersion-SHASUMS256.txt"
  Invoke-RuntimeDownload "https://nodejs.org/dist/v$nodeVersion/$nodeZipName" $nodeZip ' Node.js'
  Invoke-RuntimeDownload "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" $checksumFile ' Node.js 校验文件'
  $checksumLine = Get-Content -LiteralPath $checksumFile | Where-Object { $_ -match "\s$([regex]::Escape($nodeZipName))$" } | Select-Object -First 1
  if (-not $checksumLine) { throw '未能读取 Node.js 官方校验值。' }
  $expectedHash = ($checksumLine -split '\s+')[0].ToLowerInvariant()
  $actualHash = Get-Sha256 $nodeZip
  if ($actualHash -ne $expectedHash) {
    Write-Host 'Node.js 下载文件校验失败，正在重新下载一次……' -ForegroundColor Yellow
    Invoke-RuntimeDownload "https://nodejs.org/dist/v$nodeVersion/$nodeZipName" $nodeZip ' Node.js' -Force
    $actualHash = Get-Sha256 $nodeZip
    if ($actualHash -ne $expectedHash) { throw 'Node.js 下载文件校验失败，请检查网络后重试。' }
  }

  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  Expand-Archive -LiteralPath $nodeZip -DestinationPath $runtimeRoot -Force
  if (-not (Test-NodeRuntime $nodeExe) -or -not (Test-Path -LiteralPath $npmCmd)) {
    throw 'Node.js 本地运行环境准备失败。'
  }
  return [pscustomobject]@{ Node = $nodeExe; Npm = $npmCmd; Bundled = $true }
}

function Test-PythonRuntime {
  param([string]$PythonPath)
  if (-not $PythonPath -or -not (Test-Path -LiteralPath $PythonPath)) { return $false }
  try {
    $value = (& $PythonPath -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null | Select-Object -First 1).Trim()
    return ([version]$value) -ge ([version]'3.10')
  } catch {
    return $false
  }
}

function Find-SystemPython {
  $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($pythonCommand -and $pythonCommand.Source -notmatch '\\WindowsApps\\' -and (Test-PythonRuntime $pythonCommand.Source)) {
    return $pythonCommand.Source
  }

  $pyCommand = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($pyCommand) {
    try {
      $resolved = (& $pyCommand.Source -3 -c 'import sys; print(sys.executable)' 2>$null | Select-Object -First 1).Trim()
      if (Test-PythonRuntime $resolved) { return $resolved }
    } catch {}
  }
  return $null
}

function Get-PythonRuntime {
  $systemPython = Find-SystemPython
  if ($systemPython) { return $systemPython }

  $pythonExe = Join-Path $pythonRuntimeRoot 'python.exe'
  if (Test-PythonRuntime $pythonExe) { return $pythonExe }

  Write-Host '未检测到 Python 3.10+，将自动准备 OCR 本地运行环境。' -ForegroundColor Yellow
  $installerName = "python-$pythonVersion-amd64.exe"
  $installerPath = Join-Path $downloadRoot $installerName
  Invoke-RuntimeDownload "https://www.python.org/ftp/python/$pythonVersion/$installerName" $installerPath ' Python'
  $installerInfo = Get-Item -LiteralPath $installerPath
  $installerStream = [System.IO.File]::OpenRead($installerPath)
  try {
    $firstByte = $installerStream.ReadByte()
    $secondByte = $installerStream.ReadByte()
  } finally {
    $installerStream.Dispose()
  }
  if ($installerInfo.Length -lt 10MB -or $firstByte -ne 0x4D -or $secondByte -ne 0x5A) {
    throw 'Python 安装程序文件不完整。'
  }
  try {
    $signature = Get-AuthenticodeSignature -FilePath $installerPath -ErrorAction Stop
    if ($signature.Status -ne 'Valid') { throw 'Python 安装程序签名校验失败。' }
  } catch [System.Management.Automation.CommandNotFoundException] {
    Write-Host '当前系统无法加载签名检查模块，已确认官方网站来源和安装包基本格式。' -ForegroundColor Yellow
  } catch [System.Management.Automation.CmdletInvocationException] {
    Write-Host '当前系统无法加载签名检查模块，已确认官方网站来源和安装包基本格式。' -ForegroundColor Yellow
  }

  New-Item -ItemType Directory -Path $pythonRuntimeRoot -Force | Out-Null
  & $installerPath /quiet InstallAllUsers=0 "TargetDir=$pythonRuntimeRoot" Include_launcher=0 Include_pip=1 Include_test=0 Include_doc=0 Include_tcltk=0 Include_tools=0 Shortcuts=0 AssociateFiles=0 PrependPath=0
  $installerExitCode = $LASTEXITCODE
  if (-not (Test-PythonRuntime $pythonExe)) {
    throw "Python 本地运行环境准备失败，安装程序退出码：$installerExitCode"
  }
  return $pythonExe
}

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

$nodeRuntime = Get-NodeRuntime
$nodeExe = $nodeRuntime.Node
$npmExe = $nodeRuntime.Npm
$pythonExe = Get-PythonRuntime
$env:REVIEW_OCR_BASE_PYTHON = $pythonExe

$requiredModules = @(
  (Join-Path $serverDir 'node_modules\exceljs'),
  (Join-Path $serverDir 'node_modules\pdfjs-dist')
)
$missingDependencies = $requiredModules | Where-Object { -not (Test-Path -LiteralPath $_) }

if ($missingDependencies) {
  Write-Host '首次启动正在准备审核工具，请稍候……' -ForegroundColor Cyan
  Push-Location $serverDir
  try {
    & $npmExe install --omit=dev --no-audit --no-fund
    $npmExitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($npmExitCode -ne 0) {
    throw '依赖安装失败，请检查网络后重新双击启动。'
  }
}

Write-Host '正在启动审核软件……' -ForegroundColor Cyan
$process = Start-Process -FilePath $nodeExe -ArgumentList 'server.js' -WorkingDirectory $serverDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
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
