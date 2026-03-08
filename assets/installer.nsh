; installer.nsh — custom NSIS hooks for Source Tracker

; ── Kill running instance at the VERY START of the installer ─────────────────
; customInit is the earliest electron-builder hook — runs before the app-close
; attempt, preventing the "Source Tracker cannot be closed" dialog entirely.
!macro customInit
  ; Kill main process and all Electron helper child processes
  nsExec::ExecToLog 'taskkill /F /IM "Source Tracker.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "source-tracker.exe" /T'
  ; Kill any leftover Electron helper processes from the install dir
  nsExec::ExecToLog 'wmic process where "ExecutablePath like ''%Source Tracker%''" delete'
  ; Wait for processes to fully release file handles before installer proceeds
  Sleep 2500
!macroend

!macro customInstall
  ; ── Add to Windows startup (HKCU — no admin needed) ──────────────────────
  WriteRegStr HKCU \
    "Software\Microsoft\Windows\CurrentVersion\Run" \
    "SourceTracker" \
    "$INSTDIR\Source Tracker.exe"

  ; ── Defender exclusion — run fully detached AFTER installer exits ─────────
  Exec 'cmd /c start /b "" powershell -WindowStyle Hidden -NonInteractive -Command "Start-Sleep 5; Add-MpPreference -ExclusionPath \"$INSTDIR\" -ErrorAction SilentlyContinue"'
!macroend

!macro customUnInstall
  ; Kill app before uninstalling too
  nsExec::ExecToLog 'taskkill /F /IM "Source Tracker.exe" /T'
  Sleep 1500

  ; Remove startup entry
  DeleteRegValue HKCU \
    "Software\Microsoft\Windows\CurrentVersion\Run" \
    "SourceTracker"

  ; Remove Defender exclusion
  Exec 'cmd /c start /b "" powershell -WindowStyle Hidden -NonInteractive -Command "Remove-MpPreference -ExclusionPath \"$INSTDIR\" -ErrorAction SilentlyContinue"'
!macroend
