$env:WECOM_BOT_SECRET = Read-Host '机器人长连接 Secret' -MaskInput
node (Join-Path $PSScriptRoot 'start.cjs')
