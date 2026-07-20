#define MyAppName "入团申请材料审核助手"
#define MyAppPublisher "jzcangshu"
#define MyAppURL "https://github.com/jzcangshu/league-review-helper"
#define MyAppVersion GetEnv("LRH_VERSION")
#define PayloadDir GetEnv("LRH_PAYLOAD_DIR")
#define BuildOutputDir GetEnv("LRH_OUTPUT_DIR")

[Setup]
AppId={{F80F346C-83E3-4D74-AB5D-05DC7A5D15B8}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={localappdata}\Programs\LeagueReviewHelper
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#BuildOutputDir}
OutputBaseFilename=LeagueReviewHelper-{#MyAppVersion}-Windows-x64-Offline-Setup
SetupIconFile={#PayloadDir}\app.ico
UninstallDisplayIcon={app}\LeagueReviewHelper.exe
LicenseFile={#PayloadDir}\LICENSE
WizardStyle=modern
Compression=lzma2/ultra64
SolidCompression=yes
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
VersionInfoVersion={#MyAppVersion}.0
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} 离线安装包
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}

[Languages]
Name: "chinesesimp"; MessagesFile: "ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "其他选项："; Flags: unchecked

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Excludes: "注意事项.txt,*.pyc,runtime\node\node_modules,runtime\node\npm,runtime\node\npm.cmd,runtime\node\npm.ps1,runtime\node\npx,runtime\node\npx.cmd,runtime\node\npx.ps1,runtime\node\corepack,runtime\node\corepack.cmd,runtime\node\install_tools.bat,runtime\node\nodevars.bat"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadDir}\注意事项.txt"; DestDir: "{app}"; Flags: onlyifdoesntexist uninsneveruninstall

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\LeagueReviewHelper.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\LeagueReviewHelper.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\LeagueReviewHelper.exe"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent
