# PowerShell 7: keep the repository-scoped trigger token outside Git.
$ErrorActionPreference = 'Stop'
$tokenValue = Read-Host '粘贴仅限 CF-DNSPod-Sync 的 Fine-grained GitHub Token（输入隐藏）' -MaskInput
if (-not $tokenValue.Trim().StartsWith('github_pat_')) { throw '需要 Fine-grained token，未保存。' }
$localDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) '.local'
New-Item -ItemType Directory -Path $localDirectory -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $localDirectory 'github-actions-trigger-token.txt'), $tokenValue.Trim(), [System.Text.UTF8Encoding]::new($false))
Remove-Variable tokenValue
Write-Host '已保存到本项目忽略目录。下一步运行 npm run trigger:token 验证权限并更新时钟 Secret。'
