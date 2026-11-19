param([switch]$PayloadOnly, [switch]$InstallerOnly)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($PayloadOnly -and $InstallerOnly){throw '请选择准备载荷或生成安装包中的一项。'}
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$metadata=Get-Content -Raw -Encoding utf8 (Join-Path $root 'package.json') | ConvertFrom-Json
$version=[string]$metadata.version
if($version -notmatch '^\d+\.\d+\.\d+$'){throw '安装版本须为三段数字。'}
$product=Get-Content -Raw -Encoding utf8 (Join-Path $root 'installer/inno/product.json') | ConvertFrom-Json
if($metadata.author -ne 'Cinna' -or $metadata.build.productName -ne $product.Name -or $metadata.build.appId -ne $product.AppUserModelId){throw '产品、发布者或 Windows 身份与安装配置不一致。'}
$payloadParent=Join-Path $root ('.packaging/payload/'+$version)
$payload=Join-Path $payloadParent 'win-unpacked'
$records=Join-Path $root ('.packaging/records/'+$version)
Push-Location $root
try {
  if(-not $InstallerOnly){
    & (Join-Path $PSScriptRoot 'export-brand.ps1')
    & node --test 'tests/*.test.cjs'
    if($LASTEXITCODE -ne 0){throw '应用回归测试失败。'}
    if(-not (Test-Path -LiteralPath (Join-Path $root 'node_modules/electron/dist/electron.exe'))){
      & node node_modules/electron/install.js
      if($LASTEXITCODE -ne 0){throw 'Electron 桌面运行库准备失败。'}
    }
    & node node_modules/electron-builder/cli.js --win --dir --x64 "--config.directories.output=$payloadParent"
    if($LASTEXITCODE -ne 0){throw 'Electron 载荷构建失败。'}
    $executable=Get-Item -LiteralPath (Join-Path $payload $product.Executable)
    if($executable.VersionInfo.CompanyName -ne 'Cinna' -or ([version]$executable.VersionInfo.ProductVersion).ToString(3) -ne $version){throw '桌面程序发布者或版本不匹配。'}
    $icoPath=Join-Path $root 'assets/icon.ico'
    $installedIcon=Join-Path $payload ("resources/app-icon-$version.ico")
    if((Get-FileHash $icoPath).Hash -ne (Get-FileHash $installedIcon).Hash){throw '载荷中的版本化图标不一致。'}
  }
  if($PayloadOnly){Write-Output $payload;return}
  $staging=Join-Path $root ('.packaging/staging/'+[guid]::NewGuid().ToString('N'))
  $fileName="$($product.Name)-$version-windows-x64-setup.exe"
  $candidate=Join-Path $staging $fileName
  & (Join-Path $root 'installer/inno/build.ps1') -PayloadDirectory $payload -Version $version -OutputFile $candidate -RecordDirectory $records | Write-Host
  $record=Get-Content -Raw -Encoding utf8 (Join-Path $records 'installer.build.json') | ConvertFrom-Json
  if($record.interface -ne 'Cinna native scene installer' -or $record.qaRoot -or $record.sha256 -ne (Get-FileHash $candidate).Hash.ToLowerInvariant()){throw '安装器校验失败。'}
  & (Join-Path $PSScriptRoot 'promote-installer.ps1') -Candidate $candidate -RecordFile (Join-Path $records 'installer.build.json')
} finally {Pop-Location}

