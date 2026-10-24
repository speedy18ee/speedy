@echo off
title Push to GitHub - speedy18ee/speedy
color 0b
cls
echo ========================================================
echo        EXC SELFBOT - PUSH TO GITHUB (speedy18ee/speedy)
echo ========================================================
echo.
echo Make sure you have your GitHub Personal Access Token ready.
echo (If you do not have one: https://github.com/settings/tokens)
echo.
set /p GHTOKEN="Enter your GitHub Token (ghp_...): "

if "%GHTOKEN%"=="" (
    echo.
    echo [ERROR] Token cannot be empty!
    pause
    exit /b
)

echo.
echo Pushing repository to https://github.com/speedy18ee/speedy ...
node push.js %GHTOKEN%

echo.
pause
