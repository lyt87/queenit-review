$ErrorActionPreference = "Stop"
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BundledNode = "C:\Users\maxza\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$BundledModules = "C:\Users\maxza\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules"
$SavedKeyPath = Join-Path $AppDir "config\openai-key.dpapi"
$Node = if (Test-Path $BundledNode) { $BundledNode } else { (Get-Command node -ErrorAction Stop).Source }
Set-Location $AppDir
if (-not (Test-Path (Join-Path $AppDir "node_modules"))) {
    if (-not (Test-Path $BundledModules)) {
        throw "Codex 스프레드시트 실행 환경을 찾지 못했습니다."
    }
    New-Item -ItemType Junction -Path (Join-Path $AppDir "node_modules") -Target $BundledModules | Out-Null
}
if (-not $env:OPENAI_API_KEY -and (Test-Path $SavedKeyPath)) {
    try {
        $SavedSecureKey = Get-Content -Raw $SavedKeyPath | ConvertTo-SecureString
        $SavedBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SavedSecureKey)
        try { $env:OPENAI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($SavedBstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($SavedBstr) }
        Write-Host "저장된 GPT API 설정을 불러왔습니다." -ForegroundColor Green
    } catch {
        Write-Warning "저장된 API 설정을 불러오지 못했습니다. 키를 다시 입력해 주세요."
    }
}
if (-not $env:OPENAI_API_KEY) {
    Write-Host "GPT 실시간 리뷰 생성을 사용하려면 OpenAI API 키를 입력하세요." -ForegroundColor Cyan
    Write-Host "입력하지 않고 Enter를 누르면 기본 생성 모드로 실행됩니다."
    $SecureKey = Read-Host "OpenAI API Key" -AsSecureString
    if ($SecureKey.Length -gt 0) {
        $Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureKey)
        try { $env:OPENAI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr) }
        $SaveChoice = Read-Host "이 Windows 계정의 기본 키로 암호화 저장할까요? (Y/N)"
        if ($SaveChoice -match '^[Yy]') {
            New-Item -ItemType Directory -Force -Path (Split-Path $SavedKeyPath) | Out-Null
            $SecureKey | ConvertFrom-SecureString | Set-Content -NoNewline $SavedKeyPath
            Write-Host "API 키를 Windows 계정 전용으로 암호화 저장했습니다." -ForegroundColor Green
        }
    }
}
Write-Host "퀸잇 리뷰 메이커를 시작합니다..."
Write-Host "브라우저에서 http://127.0.0.1:4173 을 열어주세요."
& $Node "server.mjs"
