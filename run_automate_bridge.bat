@echo off
setlocal
cd /d "%~dp0"
python -m flask --app automate_bridge run --host 0.0.0.0 --port 8765
