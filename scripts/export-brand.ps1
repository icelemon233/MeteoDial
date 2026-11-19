$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Drawing
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$assets = Join-Path $root 'assets'
$brand = Join-Path $assets 'brand'
$sourcePath = Join-Path $brand 'cinna-weather-source.png'
$metadata = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = $metadata.version
$source = [Drawing.Image]::FromFile($sourcePath)
try {
  $side = 1024
  $master = [Drawing.Bitmap]::new($side,$side,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [Drawing.Graphics]::FromImage($master)
  try {
    $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([Drawing.Color]::Transparent)
    $r = 224
    $shape = [Drawing.Drawing2D.GraphicsPath]::new()
    try {
      $shape.AddArc(0,0,$r*2,$r*2,180,90)
      $shape.AddArc($side-$r*2,0,$r*2,$r*2,270,90)
      $shape.AddArc($side-$r*2,$side-$r*2,$r*2,$r*2,0,90)
      $shape.AddArc(0,$side-$r*2,$r*2,$r*2,90,90)
      $shape.CloseFigure()
      $g.SetClip($shape)
      $g.DrawImage($source,[Drawing.Rectangle]::new(0,0,$side,$side))
    } finally { $shape.Dispose() }
  } finally { $g.Dispose() }
  $sizes = @(16,20,24,32,40,48,64,128,256)
  $frames = [Collections.Generic.List[byte[]]]::new()
  try {
    foreach ($size in $sizes) {
      $bitmap = [Drawing.Bitmap]::new($size,$size,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $canvas = [Drawing.Graphics]::FromImage($bitmap)
      $stream = [IO.MemoryStream]::new()
      try {
        $canvas.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
        $canvas.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $canvas.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $canvas.DrawImage($master,[Drawing.Rectangle]::new(0,0,$size,$size))
        $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
        $frames.Add($stream.ToArray())
        if ($size -in 32,256) { [IO.File]::WriteAllBytes((Join-Path $brand "app-icon-$size.png"),$frames[$frames.Count-1]) }
      } finally { $stream.Dispose(); $canvas.Dispose(); $bitmap.Dispose() }
    }
  } finally { $master.Dispose() }
  $ico = [IO.BinaryWriter]::new([IO.File]::Create((Join-Path $assets 'icon.ico')))
  try {
    $ico.Write([uint16]0); $ico.Write([uint16]1); $ico.Write([uint16]$sizes.Count)
    $offset = 6 + $sizes.Count * 16
    for ($i=0; $i -lt $sizes.Count; $i++) {
      $dimension = [byte]($sizes[$i] % 256)
      $ico.Write($dimension); $ico.Write($dimension); $ico.Write([byte]0); $ico.Write([byte]0)
      $ico.Write([uint16]1); $ico.Write([uint16]32); $ico.Write([uint32]$frames[$i].Length); $ico.Write([uint32]$offset)
      $offset += $frames[$i].Length
    }
    foreach ($frame in $frames) { $ico.Write($frame) }
  } finally { $ico.Dispose() }
} finally { $source.Dispose() }
$files=[ordered]@{}
foreach ($name in 'icon.ico','brand/cinna-weather-source.png','brand/app-icon-32.png','brand/app-icon-256.png') {
  $files[$name]=(Get-FileHash -LiteralPath (Join-Path $assets $name) -Algorithm SHA256).Hash.ToLowerInvariant()
}
[ordered]@{product=$metadata.build.productName;developer='Cinna';version=$version;variant='weather-barometer';icoSizes=$sizes;files=$files} |
  ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $brand 'manifest.json') -Encoding utf8NoBOM
& (Join-Path $root 'installer/inno/export-scenes.ps1')
& (Join-Path $root 'installer/inno/test-assets.ps1')

