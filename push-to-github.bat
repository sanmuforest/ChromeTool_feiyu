@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  肥鱼抓兔-改 强化版 一键上传 GitHub
echo  目标: origin main (sanmuforest/ChromeTool_feiyu)
echo  注意: 需在普通终端运行（非沙箱），
echo        会使用 Windows 凭据管理器中的 GitHub 凭据
echo ============================================
echo.
git push origin main
if %errorlevel% neq 0 (
  echo.
  echo 推送失败。可能原因:
  echo  1. 未配置 GitHub 凭据 - 先执行: git config --global credential.helper manager
  echo  2. 凭据过期 - 到 GitHub 生成 PAT 后执行:
  echo     git remote set-url origin https://你的用户名:你的PAT@github.com/sanmuforest/ChromeTool_feiyu.git
  echo     再重新运行本脚本
) else (
  echo.
  echo 推送成功!
)
pause
