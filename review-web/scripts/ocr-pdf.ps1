param(
  [Parameter(Mandatory = $true)]
  [string]$PdfPath,
  [int]$RenderWidth = 2400
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

$asTaskMethods = [System.WindowsRuntimeSystemExtensions].GetMethods()

function Await-Result($operation, [Type]$resultType) {
  $method = $asTaskMethods | Where-Object {
    $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
  } | Select-Object -First 1
  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
  try { $task.Wait() } catch { throw $task.Exception.Flatten().InnerExceptions[0] }
  return $task.Result
}

function Await-Action($operation) {
  $method = $asTaskMethods | Where-Object {
    $_.Name -eq "AsTask" -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
  } | Select-Object -First 1
  $task = $method.Invoke($null, @($operation))
  try { $task.Wait() } catch { throw $task.Exception.Flatten().InnerExceptions[0] }
}

$resolvedPath = [System.IO.Path]::GetFullPath($PdfPath)
$file = Await-Result ([Windows.Storage.StorageFile]::GetFileFromPathAsync($resolvedPath)) ([Windows.Storage.StorageFile])
$document = Await-Result ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$language = [Windows.Globalization.Language]::new("zh-Hans-CN")
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
if ($null -eq $engine) {
  throw "Simplified Chinese OCR language support is unavailable."
}

$pages = [System.Collections.Generic.List[object]]::new()
for ($pageIndex = 0; $pageIndex -lt $document.PageCount; $pageIndex += 1) {
  $page = $document.GetPage($pageIndex)
  $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
  $options = [Windows.Data.Pdf.PdfPageRenderOptions]::new()
  $options.DestinationWidth = [uint32][Math]::Min($RenderWidth, [Windows.Media.Ocr.OcrEngine]::MaxImageDimension)
  Await-Action ($page.RenderToStreamAsync($stream, $options))
  $stream.Seek(0)

  $decoder = Await-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $lines = [System.Collections.Generic.List[object]]::new()
  $pageTextAngle = $null
  $tileHeight = [Math]::Min(2000, [Windows.Media.Ocr.OcrEngine]::MaxImageDimension)
  for ($tileY = 0; $tileY -lt $decoder.PixelHeight; $tileY += $tileHeight) {
    $currentHeight = [Math]::Min($tileHeight, $decoder.PixelHeight - $tileY)
    $transform = [Windows.Graphics.Imaging.BitmapTransform]::new()
    $bounds = [Windows.Graphics.Imaging.BitmapBounds]::new()
    $bounds.X = 0
    $bounds.Y = [uint32]$tileY
    $bounds.Width = [uint32]$decoder.PixelWidth
    $bounds.Height = [uint32]$currentHeight
    $transform.Bounds = $bounds
    $bitmap = Await-Result ($decoder.GetSoftwareBitmapAsync(
      [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
      [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
      $transform,
      [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
      [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
    )) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await-Result ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    if ($null -eq $pageTextAngle) { $pageTextAngle = $result.TextAngle }

    foreach ($line in $result.Lines) {
      $words = [System.Collections.Generic.List[object]]::new()
      foreach ($word in $line.Words) {
        $rect = $word.BoundingRect
        $words.Add([ordered]@{
          text = $word.Text
          x = [Math]::Round($rect.X, 2)
          y = [Math]::Round($rect.Y + $tileY, 2)
          width = [Math]::Round($rect.Width, 2)
          height = [Math]::Round($rect.Height, 2)
        })
      }
      $lines.Add([ordered]@{ text = $line.Text; words = $words })
    }
    $bitmap.Dispose()
  }

  $pages.Add([ordered]@{
    page = $pageIndex + 1
    width = $decoder.PixelWidth
    height = $decoder.PixelHeight
    textAngle = $pageTextAngle
    lines = $lines
  })

  $stream.Dispose()
  $page.Dispose()
}

[ordered]@{
  engine = "windows-ocr"
  language = "zh-Hans-CN"
  pages = $pages
} | ConvertTo-Json -Depth 8 -Compress
