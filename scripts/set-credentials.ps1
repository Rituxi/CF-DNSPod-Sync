# Run with PowerShell 7. Values are entered locally and never echoed.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$credentialsDirectory = Join-Path $projectRoot '.local'
New-Item -ItemType Directory -Path $credentialsDirectory -Force | Out-Null
$secretIdValue = Read-Host '粘贴腾讯云子用户 SecretId（输入隐藏），按回车' -MaskInput
$secretKeyValue = Read-Host '粘贴同一对 SecretKey（输入隐藏），按回车' -MaskInput
if ([string]::IsNullOrWhiteSpace($secretIdValue) -or [string]::IsNullOrWhiteSpace($secretKeyValue)) { throw '两项都需要填写，未保存。' }
$credentialValues = @{ TENCENTCLOUD_SECRET_ID = $secretIdValue.Trim(); TENCENTCLOUD_SECRET_KEY = $secretKeyValue.Trim() }
$credentialPath = Join-Path $credentialsDirectory 'dnspod-credentials.json'
[System.IO.File]::WriteAllText($credentialPath, ($credentialValues | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
Remove-Variable secretIdValue,secretKeyValue,credentialValues
Write-Host '密钥已保存在本项目忽略目录中，仅供本机命令使用。Actions 凭据请在仓库 Secrets 中配置。'
