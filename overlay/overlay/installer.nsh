; installer.nsh — custom NSIS hooks for Source Tracker
; Adds Windows Defender exclusion for the install folder (no false positives)
; Adds app to Windows startup (HKCU — no admin needed)

!macro customInstall
  ; Exclude install directory from Windows Defender
  ; (prevents false positive on Electron binaries)
  nsExec::ExecToLog 'powershell -NonInteractive -Command "Add-MpPreference -ExclusionPath \"$INSTDIR\" -ErrorAction SilentlyContinue"'

  ; Add to Windows startup
  WriteRegStr HKCU \
    "Software\Microsoft\Windows\CurrentVersion\Run" \
    "SourceTracker" \
    "$INSTDIR\Source Tracker.exe"
!macroend

!macro customUnInstall
  ; Remove Defender exclusion on uninstall
  nsExec::ExecToLog 'powershell -NonInteractive -Command "Remove-MpPreference -ExclusionPath \"$INSTDIR\" -ErrorAction SilentlyContinue"'

  ; Remove startup entry
  DeleteRegValue HKCU \
    "Software\Microsoft\Windows\CurrentVersion\Run" \
    "SourceTracker"
!macroend
