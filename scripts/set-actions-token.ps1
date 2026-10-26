# PowerShell 7: the token stays in this project's ignored local directory.
$ErrorActionPreference = 'Stop'
$tokenValue = Read-Host '粘贴 Cloudflare D1 API Token（输入隐藏），按回车' -MaskInput
if ([string]::IsNullOrWhiteSpace($tokenValue)) { throw '未输入令牌，未保存。' }
$localDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) '.local'
New-Item -ItemType Directory -Path $localDirectory -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $localDirectory 'cloudflare-actions-token.txt'), $tokenValue.Trim(), [System.Text.UTF8Encoding]::new($false))
Remove-Variable tokenValue
Write-Host '已保存到本项目忽略目录。请回复“已保存”，不要把令牌发到聊天中。'
