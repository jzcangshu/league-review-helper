param(
  [string]$Version = '',
  [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$PackageJson = Get-Content -LiteralPath (Join-Path $RepoRoot 'review-web\package.json') -Raw | ConvertFrom-Json
if (-not $Version) { $Version = [string]$PackageJson.version }
if ($Version -ne [string]$PackageJson.version) { throw "构建版本 $Version 与 package.json 版本 $($PackageJson.version) 不一致。" }

$NodeVersion = '22.19.0'
$PythonVersion = '3.11.9'
$PythonZipHash = '009D6BF7E3B2DDCA3D784FA09F90FE54336D5B60F0E0F305C37F400BF83CFD3B'
$GetPipHash = 'A341E1A43E38001C551A1508A73FF23636A11970B61D901D9A1CAD2A18F57055'
$BuildId = "v$Version-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$WorkRoot = Join-Path $RepoRoot "packaging\work\$BuildId"
$PayloadRoot = Join-Path $WorkRoot 'payload'
$DownloadRoot = Join-Path $RepoRoot 'packaging\.cache\downloads'
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $RepoRoot 'dist' }

function Assert-UnderRoot {
  param([string]$Root, [string]$Path)
  $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $resolvedPath = [IO.Path]::GetFullPath($Path)
  if (-not $resolvedPath.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "构建路径越界：$resolvedPath"
  }
}

function Download-VerifiedFile {
  param([string]$Uri, [string]$Destination, [string]$ExpectedSha256 = '')
  New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
  if (-not (Test-Path -LiteralPath $Destination)) {
    Write-Host "下载：$Uri" -ForegroundColor Cyan
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
  }
  if ($ExpectedSha256) {
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash
    if ($actual -ne $ExpectedSha256) { throw "下载文件校验失败：$Destination" }
  }
}

function Copy-ApplicationSource {
  New-Item -ItemType Directory -Path $PayloadRoot -Force | Out-Null
  foreach ($file in @('README.md', 'LICENSE', '注意事项.txt')) {
    Copy-Item -LiteralPath (Join-Path $RepoRoot $file) -Destination (Join-Path $PayloadRoot $file)
  }
  foreach ($directory in @('examples', 'codex-skills')) {
    Copy-Item -LiteralPath (Join-Path $RepoRoot $directory) -Destination (Join-Path $PayloadRoot $directory) -Recurse
  }
  $reviewTarget = Join-Path $PayloadRoot 'review-web'
  New-Item -ItemType Directory -Path $reviewTarget -Force | Out-Null
  $robocopyArgs = @(
    (Join-Path $RepoRoot 'review-web'), $reviewTarget, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
    '/XD', 'node_modules', '.runtime', '.ocr-python', '.ocr-models', '.ocr-cache', '.thumbnail-cache', 'test',
    '/XF', '*.log', 'review-web-port.txt', 'sources.local.json'
  )
  & robocopy.exe @robocopyArgs | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "复制应用程序文件失败，robocopy 退出码：$LASTEXITCODE" }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'THIRD_PARTY_NOTICES.md') -Destination (Join-Path $PayloadRoot 'THIRD_PARTY_NOTICES.md')
}

function Prepare-NodeRuntime {
  $zipName = "node-v$NodeVersion-win-x64.zip"
  $zipPath = Join-Path $DownloadRoot $zipName
  $checksums = Join-Path $DownloadRoot "node-v$NodeVersion-SHASUMS256.txt"
  Download-VerifiedFile "https://nodejs.org/dist/v$NodeVersion/$zipName" $zipPath
  Download-VerifiedFile "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" $checksums
  $line = Get-Content -LiteralPath $checksums | Where-Object { $_ -match "\s$([regex]::Escape($zipName))$" } | Select-Object -First 1
  if (-not $line) { throw '无法读取 Node.js 官方校验值。' }
  $expected = ($line -split '\s+')[0].ToUpperInvariant()
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash -ne $expected) { throw 'Node.js 压缩包校验失败。' }

  $expanded = Join-Path $WorkRoot 'node-expanded'
  Expand-Archive -LiteralPath $zipPath -DestinationPath $expanded
  $source = Join-Path $expanded "node-v$NodeVersion-win-x64"
  $destination = Join-Path $PayloadRoot 'runtime\node'
  New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Recurse
  return $destination
}

function Prepare-PythonRuntime {
  $zipName = "python-$PythonVersion-embed-amd64.zip"
  $zipPath = Join-Path $DownloadRoot $zipName
  $getPipPath = Join-Path $DownloadRoot 'get-pip.py'
  Download-VerifiedFile "https://www.python.org/ftp/python/$PythonVersion/$zipName" $zipPath $PythonZipHash
  Download-VerifiedFile 'https://bootstrap.pypa.io/get-pip.py' $getPipPath $GetPipHash

  $runtime = Join-Path $PayloadRoot 'runtime\python'
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  Expand-Archive -LiteralPath $zipPath -DestinationPath $runtime
  $pthPath = Join-Path $runtime 'python311._pth'
  $pth = (Get-Content -LiteralPath $pthPath -Raw).Replace('#import site', 'import site')
  if ($pth -notmatch '(?m)^Lib\\site-packages$') { $pth += "`r`nLib\site-packages`r`n" }
  [IO.File]::WriteAllText($pthPath, $pth, [Text.UTF8Encoding]::new($false))

  $pythonExe = Join-Path $runtime 'python.exe'
  & $pythonExe $getPipPath --disable-pip-version-check
  if ($LASTEXITCODE -ne 0) { throw '便携式 Python 的 pip 准备失败。' }
  $requirements = @(
    'paddleocr==3.7.0',
    'paddlex[ocr-core]==3.7.2',
    'onnxruntime==1.27.0',
    'pypdfium2==5.6.0'
  )
  & $pythonExe -m pip install --disable-pip-version-check --no-warn-script-location @requirements -i 'https://pypi.tuna.tsinghua.edu.cn/simple'
  if ($LASTEXITCODE -ne 0) {
    & $pythonExe -m pip install --disable-pip-version-check --no-warn-script-location @requirements
  }
  if ($LASTEXITCODE -ne 0) { throw '离线 OCR 依赖准备失败。' }
  & $pythonExe -X utf8 -c 'from paddleocr import TextDetection, TextRecognition; import onnxruntime, pypdfium2'
  if ($LASTEXITCODE -ne 0) { throw '离线 OCR 运行环境自检失败。' }
  return $pythonExe
}

function Prepare-NodeDependencies {
  param([string]$NodeRoot)
  $npm = Join-Path $NodeRoot 'npm.cmd'
  Push-Location (Join-Path $PayloadRoot 'review-web')
  try {
    & $npm ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw '生产环境 Node.js 依赖安装失败。' }
  } finally { Pop-Location }
}

function Trim-NodeRuntime {
  param([string]$NodeRoot)
  foreach ($relativePath in @(
    'node_modules',
    'npm',
    'npm.cmd',
    'npm.ps1',
    'npx',
    'npx.cmd',
    'npx.ps1',
    'corepack',
    'corepack.cmd',
    'install_tools.bat',
    'nodevars.bat'
  )) {
    $target = Join-Path $NodeRoot $relativePath
    Assert-UnderRoot $PayloadRoot $target
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Recurse -Force
    }
  }
}

function Preload-OcrModels {
  param([string]$PythonExe)
  $modelRoot = Join-Path $PayloadRoot 'review-web\.ocr-models'
  $oldModelHome = $env:PADDLE_PDX_CACHE_HOME
  $oldModelSource = $env:PADDLE_PDX_MODEL_SOURCE
  $oldSourceCheck = $env:PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK
  try {
    $env:PADDLE_PDX_CACHE_HOME = $modelRoot
    $env:PADDLE_PDX_MODEL_SOURCE = 'BOS'
    $env:PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK = 'True'
    & $PythonExe -X utf8 -c "from paddleocr import TextDetection, TextRecognition; TextDetection(model_name='PP-OCRv6_small_det', engine='onnxruntime'); TextRecognition(model_name='PP-OCRv6_tiny_rec', engine='onnxruntime')"
    if ($LASTEXITCODE -ne 0) { throw 'OCR 模型预载失败。' }
  } finally {
    $env:PADDLE_PDX_CACHE_HOME = $oldModelHome
    $env:PADDLE_PDX_MODEL_SOURCE = $oldModelSource
    $env:PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK = $oldSourceCheck
  }
  $modelFiles = Get-ChildItem -LiteralPath $modelRoot -Filter '*.onnx' -Recurse -File
  if ($modelFiles.Count -lt 2) { throw 'OCR 模型文件不完整。' }
}

function Build-NativeLauncher {
  param([string]$PythonExe)
  $iconPath = Join-Path $PayloadRoot 'app.ico'
  & $PythonExe (Join-Path $PSScriptRoot 'make_icon.py') (Join-Path $PSScriptRoot 'app-icon.png') $iconPath
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $iconPath)) { throw '应用图标生成失败。' }

  $cscCandidates = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
  )
  $csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $csc) { throw '未找到 Windows 自带的 C# 编译器。' }
  $assemblyInfo = Join-Path $WorkRoot 'AssemblyVersion.cs'
  [IO.File]::WriteAllText($assemblyInfo, "using System.Reflection;`r`n[assembly: AssemblyVersion(`"$Version.0`")]`r`n[assembly: AssemblyFileVersion(`"$Version.0`")]`r`n", [Text.UTF8Encoding]::new($false))
  $launcher = Join-Path $PayloadRoot 'LeagueReviewHelper.exe'
  & $csc /nologo /target:winexe /platform:x64 /optimize+ "/out:$launcher" "/win32icon:$iconPath" /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'LeagueReviewHelperLauncher.cs') $assemblyInfo
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcher)) { throw '原生启动器编译失败。' }
}

function Find-InnoCompiler {
  $candidates = @(
    $env:ISCC_PATH,
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
  ) | Where-Object { $_ }
  return $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

Assert-UnderRoot $RepoRoot $WorkRoot
Assert-UnderRoot $RepoRoot $OutputDirectory
New-Item -ItemType Directory -Path $WorkRoot, $OutputDirectory -Force | Out-Null
Copy-ApplicationSource
$nodeRoot = Prepare-NodeRuntime
$pythonExe = Prepare-PythonRuntime
Prepare-NodeDependencies $nodeRoot
Trim-NodeRuntime $nodeRoot
Preload-OcrModels $pythonExe
Build-NativeLauncher $pythonExe

$iscc = Find-InnoCompiler
if (-not $iscc) { throw '未找到 Inno Setup 6 的 ISCC.exe。请先安装 Inno Setup 6。' }
$compilerPayload = $PayloadRoot
$substDrive = 'R:'
$mappedDrive = $false
try {
  if ($PayloadRoot.Length -gt 80) {
    if (Test-Path "$substDrive\") { throw "构建需要临时使用 $substDrive，但该盘符已被占用。" }
    & subst.exe $substDrive $PayloadRoot
    if ($LASTEXITCODE -ne 0) { throw '无法为长路径创建临时构建盘符。' }
    $compilerPayload = "$substDrive\"
    $mappedDrive = $true
  }
  $env:LRH_VERSION = $Version
  $env:LRH_PAYLOAD_DIR = $compilerPayload
  $env:LRH_OUTPUT_DIR = [IO.Path]::GetFullPath($OutputDirectory)
  & $iscc (Join-Path $PSScriptRoot 'installer.iss')
  if ($LASTEXITCODE -ne 0) { throw 'Windows 离线安装包编译失败。' }
} finally {
  if ($mappedDrive) { & subst.exe $substDrive /d }
}

$installer = Join-Path $OutputDirectory "LeagueReviewHelper-$Version-Windows-x64-Offline-Setup.exe"
if (-not (Test-Path -LiteralPath $installer)) { throw '安装包输出文件不存在。' }
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installer).Hash.ToLowerInvariant()
$hashFile = "$installer.sha256"
[IO.File]::WriteAllText($hashFile, "$hash  $([IO.Path]::GetFileName($installer))`r`n", [Text.UTF8Encoding]::new($false))
$size = [math]::Round((Get-Item -LiteralPath $installer).Length / 1MB, 2)
Write-Host "构建完成：$installer" -ForegroundColor Green
Write-Host "体积：$size MB" -ForegroundColor Green
Write-Host "SHA-256：$hash" -ForegroundColor Green
[pscustomobject]@{ Installer = $installer; Sha256File = $hashFile; SizeMB = $size; Sha256 = $hash; WorkRoot = $WorkRoot } | ConvertTo-Json
