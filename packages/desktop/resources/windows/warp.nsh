; Openbot's IPv6 rotation (the free-usage ring) drives Cloudflare WARP through warp-cli. A first
; install on a machine without it offers to install WARP silently: the official MSI downloads from
; Cloudflare, installs only when its Authenticode signature is valid and Cloudflare's, and runs
; quiet behind Windows' own elevation prompt (WARP installs per machine, so that one prompt stays).
; Only a failed download opens WARP's page instead; a declined prompt just carries on. A machine
; that already has WARP goes straight on, and updates and silent installs never ask.
; This file is UTF-8 with a BOM so NSIS reads the Spanish copy intact.
!define WARP_CLI "$PROGRAMFILES64\Cloudflare\Cloudflare WARP\warp-cli.exe"
!define WARP_MSI_URL "https://downloads.cloudflareclient.com/v1/download/windows/ga"

!macro offerWarp
  ${IfNot} ${isUpdated}
  ${AndIfNot} ${Silent}
  ${AndIfNot} ${FileExists} "${WARP_CLI}"
    ; Spanish (traditional and modern sort) reads the Spanish copy; every other language the English.
    ${If} $LANGUAGE == 1034
    ${OrIf} $LANGUAGE == 3082
      StrCpy $R0 "No se ha encontrado Cloudflare WARP (warp-cli.exe) en este equipo.$\r$\n$\r$\nOpenbot lo usa para rotar tu IPv6. ¿Quieres instalarlo ahora?$\r$\n$\r$\nWindows te pedirá permiso de administrador una vez."
      StrCpy $R1 "Descargando Cloudflare WARP…"
      StrCpy $R2 "Instalando Cloudflare WARP…"
    ${Else}
      StrCpy $R0 "Cloudflare WARP (warp-cli.exe) was not found on this computer.$\r$\n$\r$\nOpenbot uses it to rotate your IPv6. Install it now?$\r$\n$\r$\nWindows will ask for administrator permission once."
      StrCpy $R1 "Downloading Cloudflare WARP…"
      StrCpy $R2 "Installing Cloudflare WARP…"
    ${EndIf}
    ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION "$R0" /SD IDNO IDYES`
      InitPluginsDir
      DetailPrint "$R1"
      ; Exit code 0 only with the MSI on disk and signed by Cloudflare.
      nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ProgressPreference = 'SilentlyContinue'; $$f = '$PLUGINSDIR\cloudflare-warp.msi'; try { Invoke-WebRequest -UseBasicParsing -Uri '${WARP_MSI_URL}' -OutFile $$f } catch { exit 1 }; $$s = Get-AuthenticodeSignature $$f; if ($$s.Status -ne 'Valid' -or $$s.SignerCertificate.Subject -notmatch 'Cloudflare') { Remove-Item $$f; exit 2 }; exit 0"`
      Pop $0
      ${If} $0 == 0
        DetailPrint "$R2"
        ExecShellWait "runas" "$SYSDIR\msiexec.exe" `/i "$PLUGINSDIR\cloudflare-warp.msi" /qn /norestart` SW_HIDE
        Delete "$PLUGINSDIR\cloudflare-warp.msi"
      ${Else}
        ExecShell "open" "https://one.one.one.one/"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
