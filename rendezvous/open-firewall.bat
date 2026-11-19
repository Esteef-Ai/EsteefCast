@echo off
rem Run once as Administrator (right-click > Run as administrator).
rem Opens the two ports the EsteefCast service needs in Windows Firewall.
net session >nul 2>&1 || (echo Please right-click this file and choose "Run as administrator". & pause & exit /b 1)
netsh advfirewall firewall delete rule name="EsteefCast Service" >nul 2>&1
netsh advfirewall firewall add rule name="EsteefCast Service" dir=in action=allow protocol=TCP localport=47900
netsh advfirewall firewall add rule name="EsteefCast Service" dir=in action=allow protocol=UDP localport=3478
echo.
echo Done. Windows Firewall now allows TCP 47900 and UDP 3478.
echo Also forward both ports on your router to this PC.
pause
