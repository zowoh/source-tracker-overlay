; installer.nsh — custom NSIS hooks for Source Tracker

!macro customInstall
  ; Add to Windows startup (HKCU — no admin needed)
  WriteRegStr HKCU \
    "Software\Microsoft\Windows\CurrentVersion\Run" \
    "SourceTracker" \
    "$INSTDIR\Source Tracker.exe"

  ; Defender exclusion — run fully detached AFTER installer exits
  ; Using cmd /c start /b so it never touches the installer progress bar
  Exec 'cmd /c start /b "" powershell -WindowStyle Hidden -NonInteractive -Command "Start-Sleep 5; Add-MpPreference -ExclusionPath \"$INSTDIR\" -ErrorAction SilentlyContinue"'
!macroend

!macro customUnInstall
  ; Remove startup entry
  DeleteRegValue HKCU \
    "Software\Microsoft\Windows\CurrentVersion\Run" \
    "SourceTracker"

  ; Remove Defender exclusion
  Exec 'cmd /c start /b "" powershell -WindowStyle Hidden -NonInteractive -Command "Remove-MpPreference -ExclusionPath \"$INSTDIR\" -ErrorAction SilentlyContinue"'
!macroend
