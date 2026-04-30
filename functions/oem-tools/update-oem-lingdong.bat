@echo off
REM ============================================================
REM   OEM 庫存更新 - lingdong
REM   用途：把金葉 ERP 下載的「產品價格查詢」xlsx 上傳到 Firestore
REM   建議：用 Windows 工作排程器（taskschd.msc）每週日凌晨跑一次
REM ============================================================

REM ====== 你只要改這 2 個路徑（依目標電腦的實際位置）======
set "PROJECT_DIR=D:\SAM-KINYO-WEBSITE\kinyo-price\functions"
set "XLSX_PATH=C:\oem-stock\lingdong.xlsx"
set "OEM_OWNER=lingdong@kinyo.com"
REM ===========================================================

chcp 65001 >nul
echo.
echo ============================================================
echo   OEM 庫存更新
echo   時間: %date% %time%
echo   客戶: %OEM_OWNER%
echo   檔案: %XLSX_PATH%
echo ============================================================
echo.

if not exist "%XLSX_PATH%" (
    echo [錯誤] 找不到 xlsx 檔案：
    echo   %XLSX_PATH%
    echo 請確認 ERP 已將檔案下載到此路徑。
    pause
    exit /b 1
)

if not exist "%PROJECT_DIR%\oem-tools\import-oem-products.js" (
    echo [錯誤] 找不到 import script：
    echo   %PROJECT_DIR%\oem-tools\import-oem-products.js
    echo 請檢查 PROJECT_DIR 設定是否正確。
    pause
    exit /b 1
)

cd /d "%PROJECT_DIR%"
call node oem-tools\import-oem-products.js "%XLSX_PATH%" --owner=%OEM_OWNER%
set "RC=%errorlevel%"

echo.
if "%RC%"=="0" (
    echo === 完成於 %date% %time% ===
) else (
    echo === 失敗 errorlevel=%RC% ===
)
echo.

REM 排程自動跑時請保留下面這行，會 5 秒後自動關閉視窗
REM 手動雙擊執行測試時，把下面那行改成 pause 才能看到結果
timeout /t 5 >nul
exit /b %RC%
