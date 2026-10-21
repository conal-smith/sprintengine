; Custom NSIS include for the Windows installer (package.json `build.nsis.include`).
;
; electron-builder places this file in the script header, after its command-line
; flag macros (${isUpdated}, ${isForceRun}, ${isForAllUsers}) and before its own
; templates, and calls the macros below from fixed points in them:
;
;   preInit       top of .onInit, before the one-instance mutex (installer.nsi)
;   customInit    end of .onInit, after initMultiUser has chosen $INSTDIR (installer.nsi)
;   customInstall end of the install section, after files, registry and shortcuts (installSection.nsh)
;   customUnInit  end of un.onInit, after initMultiUser (uninstaller.nsh)
;   customUnInstall  start of the uninstall section, before any file is removed (uninstaller.nsh)
;
; customUnInstall is described where it is defined, at the end of this file.
;
; What it is for: an update installs over the installation that is running,
; wherever that is (owner ruling 2026-09-24). The installer is one-click and
; per-user (`oneClick: true, perMachine: false`), and on its own it only knows a
; per-user installation: multiUser.nsh's setInstallModePerUser reads
; InstallLocation from HKCU and otherwise picks %LOCALAPPDATA%\Programs. Stable
; 0.4.0 to 0.6.0 shipped the assisted installer, which could also install for all
; users (Program Files, recorded in HKLM) or into a folder of the person's
; choosing. Updating one of those with the stock one-click installer puts a
; second copy under %LOCALAPPDATA%\Programs, and the copy the shortcuts start
; never updates.
;
; So, only when the installer runs as an update (`--updated`):
;
;  1. Find the folder to install into. In order: the /D= the app passed (this
;     build's app always does); else the folder of the process that started the
;     installer, when that process is the app itself (an older build, which
;     passes no folder); else the registry, HKCU first, then HKLM.
;  2. If that folder is the one HKLM records, this is an all-users
;     installation: switch to all-users mode (SetShellVarContext all, so
;     SHELL_CONTEXT is HKLM and the shortcuts are the common ones) and, when not
;     already elevated, relaunch elevated once for this update.
;  3. The uninstaller written into an all-users installation is this per-user
;     build's, and its un.onInit would otherwise look in HKCU. Its uninstall
;     string says /allusers (registryAddInstallInfo writes that when
;     $installMode is "all"), so customUnInit switches it to all-users mode too.
;
; makensis runs with -WX here (warnings are errors), so every Var below is used
; in the build that declares it, and there are no Functions (an unreferenced
; Function is a warning).

!ifndef BUILD_UNINSTALLER

  ; The folder this update installs into; empty when the installer is not
  ; running as an update, or found nothing, and stock behaviour applies.
  Var updateTargetDir
  ; "1" when $updateTargetDir is the all-users installation recorded in HKLM.
  Var updateTargetPerMachine
  ; The pid of the app that started this installer, when it could be read.
  Var updateLauncherPid
  ; A per-user installation somewhere else, which the all-users update removes.
  Var updateStrayPerUserDir

  !macro updateTrimTrailingSlash VAR
    Push $R9
    StrCpy $R9 ${VAR} 1 -1
    ${If} $R9 == "\"
      StrCpy ${VAR} ${VAR} -1
    ${EndIf}
    Pop $R9
  !macroend

  ; Wait (bounded) for a process to exit. SYNCHRONIZE access is all it needs,
  ; which an elevated installer has over a process of the signed-in user.
  !macro updateWaitForExit PID TIMEOUT_MS
    Push $R1
    Push $R2
    System::Call 'kernel32::OpenProcess(i 0x00100000, i 0, i ${PID}) p.R1'
    ${If} $R1 <> 0
      System::Call 'kernel32::WaitForSingleObject(p R1, i ${TIMEOUT_MS}) i.R2'
      System::Call 'kernel32::CloseHandle(p R1)'
    ${EndIf}
    Pop $R2
    Pop $R1
  !macroend

  !macro updateResolveTarget
    StrCpy $updateTargetDir ""
    StrCpy $updateTargetPerMachine "0"
    StrCpy $updateLauncherPid "0"
    StrCpy $updateStrayPerUserDir ""

    ; .onInit sets the 64-bit view only after preInit (check64BitAndSetRegView,
    ; common.nsh). The installations being looked for were written in that view.
    ${If} ${RunningX64}
      SetRegView 64
    ${EndIf}

    ; 1. The folder the app named. NSIS takes /D= only as the last argument and
    ;    unquoted, which is how the app passes it; GetDParameter (multiUser.nsh)
    ;    reads it back from the full command line so a path with spaces survives.
    ;    The app names itself too (--wait-for-pid), and that is carried into an
    ;    elevated relaunch below.
    !insertmacro GetDParameter $R0
    ${If} $R0 != ""
      StrCpy $updateTargetDir $R0
      ${StdUtils.GetParameter} $R1 "wait-for-pid" ""
      IntOp $R1 $R1 + 0
      ${If} $R1 > 0
        StrCpy $updateLauncherPid $R1
      ${EndIf}
    ${Else}
      ; 2. An older build passes no folder, but it is the process that started
      ;    this installer (electron-updater spawns it from the app's main
      ;    process). QueryFullProcessImageNameW, not GetProcessInfo's module
      ;    path: this installer is a 32-bit process and the app is 64-bit, which
      ;    GetModuleFileNameEx cannot read across. By the time the installer
      ;    gets here the app may have exited; then the name no longer matches
      ;    and the registry decides.
      ${GetProcessInfo} 0 $0 $1 $2 $3 $4
      ${If} $1 > 0
        System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i r1) p.r2'
        ${If} $2 <> 0
          System::Call 'kernel32::QueryFullProcessImageNameW(p r2, i 0, w .r3, *i ${NSIS_MAX_STRLEN}) i.r4'
          System::Call 'kernel32::CloseHandle(p r2)'
          ${If} $4 <> 0
            ${GetFileName} $3 $5
            ${If} $5 == "${APP_EXECUTABLE_FILENAME}"
              StrCpy $updateLauncherPid $1
              ${GetParent} $3 $updateTargetDir
            ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}

    ; 3. Neither: the registry. An older build's install at quit lands here
    ;    (the app is gone by the time the installer has checked its own CRC).
    ;    A per-user installation first, as stock setInstallModePerUser does,
    ;    then an all-users one. One exception: a per-user installation in the
    ;    one-click default folder beside an all-users installation is the stray
    ;    copy an earlier one-click update left (the assisted installer named its
    ;    per-user folder after the product, not the package), so the all-users
    ;    installation, which its shortcuts start, is the one updated, and the
    ;    update removes the stray.
    ${If} $updateTargetDir == ""
      ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
      ReadRegStr $R1 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
      !insertmacro updateTrimTrailingSlash $R0
      ${If} $R0 == ""
        StrCpy $R0 $R1
      ${ElseIf} $R1 != ""
      ${AndIf} $R0 == "$LOCALAPPDATA\Programs\${APP_FILENAME}"
        StrCpy $R0 $R1
      ${EndIf}
      StrCpy $updateTargetDir $R0
    ${EndIf}

    ${If} $updateTargetDir != ""
      !insertmacro updateTrimTrailingSlash $updateTargetDir
      ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
      !insertmacro updateTrimTrailingSlash $R0
      ; `==` is StrCmp, which ignores case, as Windows paths do.
      ${If} $R0 != ""
      ${AndIf} $R0 == $updateTargetDir
        StrCpy $updateTargetPerMachine "1"
        ReadRegStr $R1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
        !insertmacro updateTrimTrailingSlash $R1
        ${If} $R1 != ""
        ${AndIf} $R1 != $updateTargetDir
          StrCpy $updateStrayPerUserDir $R1
        ${EndIf}
      ${EndIf}
    ${EndIf}
  !macroend

  ; An all-users installation needs an administrator. This build's app asks for
  ; that itself before it quits (so a refusal leaves it running), and starts the
  ; installer already elevated. An older build (0.6.0 and earlier, on Restart
  ; to update or at quit) starts it as the user, and the installer relaunches
  ; itself elevated here, before the one-instance mutex exists, so the elevated
  ; copy can take it.
  !macro updateElevateIfNeeded
    ${If} $updateTargetPerMachine == "1"
    ${AndIfNot} ${UAC_IsAdmin}
      ${StdUtils.TestParameter} $R0 "update-elevated"
      ${If} $R0 == "true"
        ; Already relaunched once and still not elevated: stop, not loop, and
        ; bring back the version that is installed if the app asked for that.
        ${If} ${isForceRun}
          Exec '"$updateTargetDir\${APP_EXECUTABLE_FILENAME}"'
        ${EndIf}
        SetErrorLevel 740
        Quit
      ${EndIf}

      StrCpy $R1 "--updated"
      ${If} ${Silent}
        StrCpy $R1 "$R1 /S"
      ${EndIf}
      ${If} ${isForceRun}
        StrCpy $R1 "$R1 --force-run"
      ${EndIf}
      ${If} $updateLauncherPid > 0
        StrCpy $R1 "$R1 --wait-for-pid=$updateLauncherPid"
      ${EndIf}
      ; /D= last and unquoted: the NSIS rule, and what GetDParameter expects.
      StrCpy $R1 "$R1 --update-elevated /D=$updateTargetDir"

      ClearErrors
      ExecShell "runas" "$EXEPATH" "$R1"
      ${If} ${Errors}
        ; Elevation was refused or failed. Nothing has been touched, so the
        ; installed version still works; start it again if the app asked to be
        ; restarted, once the copy that launched this installer has exited (the
        ; app is single-instance).
        ${If} ${isForceRun}
          ${If} $updateLauncherPid > 0
            !insertmacro updateWaitForExit $updateLauncherPid 60000
          ${EndIf}
          Exec '"$updateTargetDir\${APP_EXECUTABLE_FILENAME}"'
        ${EndIf}
        SetErrorLevel 1223
        Quit
      ${EndIf}
      !insertmacro quitSuccess
    ${EndIf}
  !macroend

  !macro preInit
    ${If} ${isUpdated}
      !insertmacro updateResolveTarget
      !insertmacro updateElevateIfNeeded
    ${EndIf}
  !macroend

  !macro customInit
    ${If} $updateTargetDir != ""
      StrCpy $INSTDIR $updateTargetDir
      ${If} $updateTargetPerMachine == "1"
        ; What setInstallModePerAllUsers does, which a per-user build does not
        ; compile in (INSTALL_MODE_PER_ALL_USERS_REQUIRED is only defined for an
        ; assisted or per-machine build).
        StrCpy $installMode all
        SetShellVarContext all
      ${EndIf}
    ${EndIf}

    ; The app starts the installer before it has finished quitting, and passes
    ; its pid so the installer waits for it instead of force-closing it
    ; (CHECK_APP_RUNNING kills a running app about a second after it looks).
    ; Bounded: a hung app is then closed the stock way.
    ${StdUtils.GetParameter} $R0 "wait-for-pid" ""
    IntOp $R0 $R0 + 0
    ${If} $R0 > 0
      !insertmacro updateWaitForExit $R0 60000
    ${EndIf}
  !macroend

  !macro customInstall
    ; An all-users update also runs the uninstaller of a per-user installation
    ; (installSection.nsh, when $installMode is "all"). That uninstall normally
    ; removes its own shortcuts already: it is started without --keep-shortcuts,
    ; because the all-users exe was moved away by the first uninstall
    ; (installUtil.nsh uninstallOldVersion tests ${FileExists} "$appExe"). The
    ; deletes below cover an older per-user uninstaller that kept them anyway;
    ; a shortcut left pointing at the removed copy would start nothing. The
    ; all-users shortcuts are untouched. (That uninstaller also clears the
    ; app's AppUserModelID jump list, which the all-users copy shares; the
    ; jump list refills as the app is used.)
    ${If} $updateTargetPerMachine == "1"
    ${AndIf} $updateStrayPerUserDir != ""
      SetShellVarContext current
      Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
      !ifdef MENU_FILENAME
        Delete "$SMPROGRAMS\${MENU_FILENAME}\${SHORTCUT_NAME}.lnk"
        RMDir "$SMPROGRAMS\${MENU_FILENAME}"
      !else
        Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
      !endif
      SetShellVarContext all
    ${EndIf}

    ; An update or a reinstall over an installation keeps the shortcuts it
    ; finds (KeepShortcuts), and addStartMenuLink then creates nothing when the
    ; Start Menu entry is already gone (removed by hand, or by a profile
    ; cleanup), so the app could no longer be found from Start. It is put back
    ; with the same lines addStartMenuLink runs on a fresh install;
    ; $newStartMenuLink is the link it would have made there, in the shell
    ; context this install runs in.
    !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
      ${IfNot} ${FileExists} "$newStartMenuLink"
        !insertmacro createMenuDirectory
        CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
        ClearErrors
        WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
      ${EndIf}
    !endif
  !macroend

!endif

!ifdef BUILD_UNINSTALLER

  ; An all-users installation's uninstall string ends in /allusers. Without
  ; this the per-user uninstaller would read HKCU, remove a folder under
  ; %LOCALAPPDATA%\Programs that is not there, and leave the Program Files copy
  ; and its Apps & features entry behind.
  !macro customUnInit
    ${If} ${isForAllUsers}
      ReadRegStr $R1 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${If} $R1 != ""
        ${IfNot} ${UAC_IsAdmin}
          ; Relaunch elevated and silent: un.onInit has already asked "are you
          ; sure", and asking again from the elevated copy would be twice.
          ; _?= keeps the copy from moving itself to TEMP again and sets
          ; $INSTDIR; like /D=, it must be last and unquoted.
          ClearErrors
          ExecShell "runas" "$EXEPATH" "/S /allusers _?=$R1"
          ${If} ${Errors}
            SetErrorLevel 1223
          ${Else}
            SetErrorLevel 0
          ${EndIf}
          Quit
        ${EndIf}
        StrCpy $installMode all
        SetShellVarContext all
        StrCpy $INSTDIR $R1
      ${EndIf}
    ${EndIf}
  !macroend

  ; Uninstalling for good: take Studio's integrations back out before its files
  ; go, and ask whether its data goes too.
  ;
  ; An update runs this uninstaller as well — the new installer runs the OLD
  ; one, always with --updated (installUtil.nsh uninstallOldVersion) — and must
  ; leave every integration and all data exactly where they are, so none of this
  ; runs under ${isUpdated}.
  ;
  ; The installed app does the removal itself (--remove-integrations: the same
  ; code as Settings > General > Remove integrations), before the files it runs
  ; from are deleted. It bounds itself with --timeout and exits whatever
  ; happens; its exit code is only logged, because nothing here may stop the
  ; uninstall. un.onInit has already closed a running app (CHECK_APP_RUNNING).
  !macro customUnInstall
    ${IfNot} ${isUpdated}
      ; Asked only when a person started the uninstall. An explicit /S (a
      ; package manager, a script) keeps the data, the stock default. The
      ; one-click uninstaller turns silent itself after its confirmation, so
      ; the command line is what says which it was.
      StrCpy $R8 "0"
      ${GetParameters} $R0
      ClearErrors
      ${GetOptions} $R0 "/S" $R1
      ${If} ${Errors}
        ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION "Also delete SprintEngine Studio's settings, logs and downloaded runtimes?$\r$\n$\r$\nYour repositories, your extensions and the agent CLIs you installed are kept either way." IDYES`
          StrCpy $R8 "1"
        ${EndIf}
      ${EndIf}

      ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        DetailPrint "Removing SprintEngine Studio's integrations..."
        ; Bounded twice: the app ends itself at --timeout, and PowerShell stops
        ; waiting (and ends it) a little after that, so an app that hangs
        ; before its own timer starts cannot hold the uninstall. The small
        ; pause lets the processes it started let go of the install folder.
        ClearErrors
        nsExec::ExecToLog `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$p = Start-Process -FilePath '$INSTDIR\${APP_EXECUTABLE_FILENAME}' -ArgumentList '--remove-integrations','--timeout=90000' -PassThru -WindowStyle Hidden; if (-not $$p.WaitForExit(120000)) { $$p.Kill(); exit 3 }; exit $$p.ExitCode"`
        Pop $R2
        DetailPrint "Integration removal finished: $R2."
        Sleep 1000
      ${EndIf}

      ; The link handler the app registers for itself: Electron writes it under
      ; the person's own classes, so the stock uninstaller never knew about it.
      ; The step above removes it too; this covers an app that could not run.
      ; Only when it still opens THIS installation: another copy (a second
      ; install, a development build) may have claimed it since.
      ReadRegStr $R3 HKCU "Software\Classes\sprintengine\shell\open\command" ""
      StrLen $R5 "$INSTDIR"
      StrCpy $R4 $R3 $R5 1
      StrCpy $R6 $R3 $R5
      ${If} $R4 == "$INSTDIR"
      ${OrIf} $R6 == "$INSTDIR"
        DeleteRegKey HKCU "Software\Classes\sprintengine"
      ${EndIf}

      ${If} $R8 == "1"
        ; The profile directories the stock --delete-app-data removes, and the
        ; runtime shims Studio downloaded.
        ${If} $installMode == "all"
          SetShellVarContext current
        ${EndIf}
        RMDir /r "$APPDATA\${APP_FILENAME}"
        !ifdef APP_PRODUCT_FILENAME
          RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
        !endif
        !ifdef APP_PACKAGE_NAME
          RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
        !endif
        RMDir /r "$LOCALAPPDATA\SprintEngine\runtime-bin"
        RMDir "$LOCALAPPDATA\SprintEngine"
        ${If} $installMode == "all"
          SetShellVarContext all
        ${EndIf}
      ${EndIf}
    ${EndIf}
  !macroend

!endif
