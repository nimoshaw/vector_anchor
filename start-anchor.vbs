' Vector Anchor - silent startup
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """D:\projects\vector_anchor\start-anchor.bat""", 0, False
Set WshShell = Nothing
