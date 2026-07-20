[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [string]$InstallDirectory = "",

  [int]$StartupTimeoutSeconds = 60,

  [int]$OcrTimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'

function Resolve-FullPath([string]$PathValue) {
  $executionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PathValue)
}

function Invoke-LocalJson {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Uri,

    [string]$Method = 'GET',

    [object]$Body = $null,

    [int]$TimeoutSeconds = 30
  )

  $options = @{
    Uri = $Uri
    Method = $Method
    TimeoutSec = $TimeoutSeconds
  }
  if ($null -ne $Body) {
    $options.ContentType = 'application/json; charset=utf-8'
    $options.Body = $Body | ConvertTo-Json -Depth 30
  }
  Invoke-RestMethod @options
}

function Stop-InstalledProcesses {
  param([Parameter(Mandatory = $true)][string]$InstallRoot)

  $normalized = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
  Get-CimInstance Win32_Process |
    Where-Object {
      ($_.Name -in @('node.exe', 'LeagueReviewHelper.exe')) -and
      $_.CommandLine -and
      $_.CommandLine.IndexOf($normalized, [StringComparison]::OrdinalIgnoreCase) -ge 0
    } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

$installer = Resolve-FullPath $InstallerPath
if (-not (Test-Path -LiteralPath $installer)) {
  throw "安装包不存在：$installer"
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $InstallDirectory.Trim()) {
  $InstallDirectory = Join-Path $env:LOCALAPPDATA "LRH120FinalCheck-$stamp"
}
$installRoot = Resolve-FullPath $InstallDirectory
$installLog = Join-Path $env:TEMP "lrh-offline-install-$stamp.log"

$setup = Start-Process -FilePath $installer -ArgumentList @(
  '/VERYSILENT',
  '/SUPPRESSMSGBOXES',
  '/NORESTART',
  "/DIR=$installRoot",
  "/LOG=$installLog"
) -Wait -PassThru
if ($setup.ExitCode -ne 0) {
  throw "安装器退出码 $($setup.ExitCode)，日志：$installLog"
}

$requiredItems = @(
  'LeagueReviewHelper.exe',
  'review-web\server.js',
  'review-web\node_modules',
  'review-web\.ocr-models',
  'runtime\node\node.exe',
  'runtime\python\python.exe'
)
foreach ($item in $requiredItems) {
  $path = Join-Path $installRoot $item
  if (-not (Test-Path -LiteralPath $path)) {
    throw "安装内容缺失：$item"
  }
}

$forbiddenItems = @(
  'runtime\node\node_modules',
  'runtime\node\npm.cmd',
  'runtime\node\npx.cmd',
  'runtime\node\corepack.cmd'
)
$forbiddenPresent = @()
foreach ($item in $forbiddenItems) {
  if (Test-Path -LiteralPath (Join-Path $installRoot $item)) {
    $forbiddenPresent += $item
  }
}
if ($forbiddenPresent.Count) {
  throw "安装目录包含不应分发的 Node 工具：$($forbiddenPresent -join ', ')"
}

$launcherPath = Join-Path $installRoot 'LeagueReviewHelper.exe'
$processInfo = [Diagnostics.ProcessStartInfo]::new($launcherPath)
$processInfo.WorkingDirectory = $installRoot
$processInfo.UseShellExecute = $false
$processInfo.EnvironmentVariables['LEAGUE_REVIEW_NO_BROWSER'] = '1'
$processInfo.EnvironmentVariables['PATH'] = "$env:SystemRoot\System32;$env:SystemRoot"
$processInfo.EnvironmentVariables['HTTP_PROXY'] = 'http://127.0.0.1:9'
$processInfo.EnvironmentVariables['HTTPS_PROXY'] = 'http://127.0.0.1:9'
$processInfo.EnvironmentVariables['NO_PROXY'] = '127.0.0.1,localhost'

$launcher = [Diagnostics.Process]::Start($processInfo)
$deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
$health = $null
$port = $null
$portFile = Join-Path $env:TEMP 'review-web-port.json'

while ((Get-Date) -lt $deadline) {
  if (Test-Path -LiteralPath $portFile) {
    try {
      $candidatePort = (Get-Content -Raw -LiteralPath $portFile | ConvertFrom-Json).port
      if ($candidatePort) {
        $candidateHealth = Invoke-LocalJson -Uri "http://127.0.0.1:$candidatePort/api/health" -TimeoutSeconds 2
        $candidateRoot = [IO.Path]::GetFullPath([string]$candidateHealth.workspaceRoot).TrimEnd('\')
        if ($candidateHealth.ok -and $candidateRoot.Equals($installRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
          $health = $candidateHealth
          $port = $candidatePort
          break
        }
      }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  Start-Sleep -Milliseconds 500
}

if (-not $health) {
  Stop-InstalledProcesses -InstallRoot $installRoot
  throw "安装版服务未在 $StartupTimeoutSeconds 秒内通过健康检查。"
}

$pdfDir = Join-Path $installRoot 'examples\示例中学\入团申请资料'
$excelPath = Join-Path $installRoot 'examples\示例中学\示例中学团员名单.xlsx'
$analysis = Invoke-LocalJson -Method POST -Uri "http://127.0.0.1:$port/api/import/analyze" -TimeoutSeconds 60 -Body @{
  school = '示例中学'
  pdfDir = $pdfDir
  excelPath = $excelPath
  resultColumn = ''
  layout = @{}
  rowOverrides = @{}
}

if ($analysis.summary.pdfCount -lt 3 -or $analysis.summary.matchedCount -lt 3) {
  throw "导入分析结果异常：$($analysis.summary | ConvertTo-Json -Compress)"
}

$commit = Invoke-LocalJson -Method POST -Uri "http://127.0.0.1:$port/api/import/commit" -TimeoutSeconds 60 -Body @{
  school = '示例中学'
  pdfDir = $pdfDir
  excelPath = $excelPath
  resultColumn = ''
  layout = $analysis.excelLayout
  rowOverrides = @{}
  analysisId = $analysis.analysisId
  sourceId = ''
  bindings = @{}
  resolutions = @{}
}
if (-not $commit.ok) {
  throw '导入提交接口未返回 ok。'
}

$bootstrap = Invoke-LocalJson -Uri "http://127.0.0.1:$port/api/bootstrap" -TimeoutSeconds 10
$item = $bootstrap.items | Where-Object { $_.hasPdf } | Select-Object -First 1
if (-not $item) {
  throw '导入后未找到带 PDF 的审核项。'
}
$encodedItemId = [uri]::EscapeDataString([string]$item.id)

$thumbnails = Invoke-LocalJson -Uri "http://127.0.0.1:$port/api/pdf-thumbnails/$encodedItemId" -TimeoutSeconds 90
if (-not $thumbnails.pages -or $thumbnails.pages.Count -lt 1) {
  throw '缩略图接口未返回页面。'
}

$ocrStart = Get-Date
$ocr = Invoke-LocalJson -Uri "http://127.0.0.1:$port/api/ocr/$encodedItemId" -TimeoutSeconds $OcrTimeoutSeconds
$ocrMs = [int]((Get-Date) - $ocrStart).TotalMilliseconds
if (-not $ocr.pages -or $ocr.pages.Count -lt 1) {
  throw 'OCR 接口未返回页面。'
}

$uninstallerPath = Join-Path $installRoot 'unins000.exe'
$startMenuShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) '入团申请材料审核助手\入团申请材料审核助手.lnk'
$registry = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object {
    $_.InstallLocation -and
    [IO.Path]::GetFullPath([string]$_.InstallLocation).TrimEnd('\').Equals($installRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
  } |
  Select-Object -First 1

Stop-InstalledProcesses -InstallRoot $installRoot
if ($launcher -and -not $launcher.HasExited) {
  Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue
}

[pscustomobject]@{
  installDir = $installRoot
  installLog = $installLog
  version = $health.version
  workspaceRoot = $health.workspaceRoot
  importPdfCount = $analysis.summary.pdfCount
  importMatchedCount = $analysis.summary.matchedCount
  commitCreated = $commit.created
  thumbnailPages = $thumbnails.pages.Count
  ocrPages = $ocr.pages.Count
  ocrMilliseconds = $ocrMs
  uninstaller = Test-Path -LiteralPath $uninstallerPath
  startMenuShortcut = Test-Path -LiteralPath $startMenuShortcut
  registryDisplayVersion = $registry.DisplayVersion
  forbiddenRuntimeFiles = $forbiddenPresent.Count
} | ConvertTo-Json -Depth 4
