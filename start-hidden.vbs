' 哔哩下载器 · 静默启动本地代理（无窗口，供 start-server.bat 调用）
' 用法：wscript //nologo start-hidden.vbs
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = WScript.CreateObject("WScript.Shell")
shell.CurrentDirectory = scriptDir
' 0 = 隐藏窗口，False = 不等待进程结束
shell.Run """node"" server.js", 0, False
