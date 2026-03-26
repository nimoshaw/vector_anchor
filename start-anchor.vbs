' Vector Anchor — 静默启动（无弹窗）
' 用于放入 Windows 启动目录实现开机自启

Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """D:\projects\vector_anchor\start-anchor.bat""", 0, False
Set WshShell = Nothing
