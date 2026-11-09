@echo off
rem Lance Cadence sur cet ordinateur, avec les comptes de demonstration.
cd /d "%~dp0"
set CADENCE_DEMO=1
call npm start
pause
