param([string]$OutputDirectory=(Join-Path $env:TEMP ('soulstone-speech-'+[guid]::NewGuid())),[switch]$Baseline)
$ErrorActionPreference='Stop'
$desktop=Split-Path $PSScriptRoot
$framework=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$exe=Join-Path $OutputDirectory 'WindowsSpeechFixture.exe'
& "$framework\csc.exe" /nologo /platform:x64 /target:exe /main:WindowsSpeechFixture "/out:$exe" "/reference:$framework\WPF\System.Speech.dll" "/reference:$framework\System.Web.Extensions.dll" "$desktop\native\Voice.cs" "$desktop\test\WindowsSpeechFixture.cs"
if($LASTEXITCODE -ne 0){throw 'Speech fixture compilation failed'}
$arguments=@($OutputDirectory)
if($Baseline){$arguments+='baseline'}
& $exe @arguments
$code=$LASTEXITCODE
Write-Host "Synthetic WAV files retained in $OutputDirectory"
exit $code
