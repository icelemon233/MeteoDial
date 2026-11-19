param([Parameter(Mandatory)][string]$Candidate, [Parameter(Mandatory)][string]$RecordFile)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$internal=Join-Path $root '.packaging'
$public=Join-Path $root 'installers'
$record=Get-Content -Raw -Encoding utf8 -LiteralPath $RecordFile | ConvertFrom-Json
$product=Get-Content -Raw -Encoding utf8 (Join-Path $root 'installer/inno/product.json')|ConvertFrom-Json
if($record.qaRoot -or $record.product -ne $product.Name -or $record.version -notmatch '^\d+\.\d+\.\d+$' -or $record.interface -ne 'Cinna native scene installer'){
  throw '只接收与本项目匹配的正式 Inno 构建记录。'
}
$version=[string]$record.version
$wanted="$($product.Name)-$version-windows-x64-setup.exe"
$candidatePath=(Resolve-Path -LiteralPath $Candidate).Path
function Digest([string]$file){return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
if((Split-Path -Leaf $candidatePath) -ne $wanted -or (Digest $candidatePath) -ne $record.sha256){throw '待交付安装器的文件名或校验值不匹配。'}
foreach($d in @($internal,$public)){[void](New-Item -ItemType Directory -Force -Path $d);if((Get-Item -Force -LiteralPath $d).Attributes -band [IO.FileAttributes]::ReparsePoint){throw '交付目录不能指向其他位置。'}}
$receipt=Join-Path $internal 'public-installer.json'
function Is-GuanxiangReceipt($entry){
  return ($null -ne $entry -and $product.Id -eq 'org.guanxiang.weather' -and $entry.version -eq '0.2.0' -and $entry.name -eq 'Guanxiang-0.2.0-windows-x64-setup.exe')
}
function Verify-Entry($entry){
  if($null -eq $entry){return}
  $recognizedName=$entry.name -eq "$($product.Name)-$($entry.version)-windows-x64-setup.exe" -or (Is-GuanxiangReceipt $entry)
  if($entry.version -notmatch '^\d+\.\d+\.\d+$' -or -not $recognizedName -or $entry.sha256 -notmatch '^[0-9a-f]{64}$'){throw '未知的历史交付记录。'}
}
$lock=[IO.File]::Open((Join-Path $internal 'publish.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
  $old=$null
  if(Test-Path -LiteralPath $receipt){
    $state=Get-Content -LiteralPath $receipt -Raw -Encoding utf8|ConvertFrom-Json
    $previousBrand=$state.product -eq 'Guanxiang' -and (Is-GuanxiangReceipt $state.current)
    if($state.schema -ne 1 -or ($state.product -ne $product.Name -and -not $previousBrand)){throw '已有交付记录属于其他产品。'}
    $old=$state.current;Verify-Entry $old
  }
  $target=Join-Path $public $wanted
  if(Test-Path -LiteralPath $target){
    $existing=Digest $target
    if($existing -ne $record.sha256 -and ($null -eq $old -or $old.name -ne $wanted -or $old.sha256 -ne $existing)){throw '目标文件与已知交付记录不一致，原文件已保留。'}
  }
  $previous=$null
  if($old -and $old.sha256 -ne $record.sha256){
    $oldFile=Join-Path $public $old.name
    $history=Join-Path $internal ('history/'+$old.version+'/'+$old.sha256)
    $backup=Join-Path $history $old.name
    if(Test-Path -LiteralPath $oldFile){
      $oldDigest=Digest $oldFile
      if($oldDigest -eq $old.sha256){
        [void](New-Item -ItemType Directory -Force -Path $history)
        if(-not (Test-Path -LiteralPath $backup)){[IO.File]::Copy($oldFile,$backup,$false)}
      }elseif($old.name -ne $wanted -or $oldDigest -ne $record.sha256){
        throw '原安装包已被更改，不能归档为可恢复版本。'
      }
    }
    if(-not (Test-Path -LiteralPath $backup) -or (Digest $backup) -ne $old.sha256){throw '未能验证前一版安装包的备份。'}
    $previous=$old
  }elseif($old -and $state.PSObject.Properties['previous']){
    $previous=$state.previous;Verify-Entry $previous
  }
  if(-not (Test-Path -LiteralPath $target) -or (Digest $target) -ne $record.sha256){
    $tmp=Join-Path $internal ('.candidate-'+[guid]::NewGuid().ToString('N'))
    try {
      [IO.File]::Copy($candidatePath,$tmp,$false)
      if((Digest $tmp) -ne $record.sha256){throw '安装包复制校验失败。'}
      [IO.File]::Move($tmp,$target,$true)
    }finally{if(Test-Path -LiteralPath $tmp){Remove-Item -LiteralPath $tmp}}
  }
  $newEntry=[ordered]@{version=$version;name=$wanted;sha256=$record.sha256}
  $stateFile=$receipt+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  [ordered]@{schema=1;product=$product.Name;current=$newEntry;previous=$previous} | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8NoBOM -LiteralPath $stateFile
  [IO.File]::Move($stateFile,$receipt,$true)
  if($previous -and $previous.name -ne $wanted){
    $retired=Join-Path $public $previous.name
    if((Test-Path -LiteralPath $retired) -and (Digest $retired) -eq $previous.sha256){Remove-Item -LiteralPath $retired}
  }
  Write-Output $target
} finally { $lock.Dispose() }

