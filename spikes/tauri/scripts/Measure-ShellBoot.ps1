# Protocolo del spike: arranque frío (t entre el arranque y la primera ventana
# principal propia) + RAM privada del arbol completo a los 30 s. Todas las
# repeticiones usan instancias AISLADAS (userData distinto de la app viva: la
# app de Escritorio acepta OPENCODE_DESKTOP_TEST_ROOT, que remapea userData y
# XDG_*; el bloqueo de instancia unica queda acotado a ese userData) y cada
# arbol muere al terminar su repeticion, nunca el arbol de la app viva.
# Uso: .\Measure-ShellBoot.ps1 -Exe <exe> -Label <nombre> [-Warmup]
# Nota PowerShell: los conjuntos se devuelven dentro de hashtables porque el
# pipeline des-enrolla colecciones de un solo elemento.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Label,
  [int]$Reps = 3,
  [string]$FreshVar,
  [switch]$Warmup
)

# Ruta base de los userData frescos por repeticion (evita que estado persistido
# como un update pendiente del updater altere las repeticiones 2+)
$script:FreshBase = Join-Path $PSScriptRoot "roots\${Label}"

function Get-DiccionarioPadres { [System.Collections.Generic.Dictionary[int, int]]::new() }

# ids del arbol de un pid (raiz + descendientes) via mapa de padres WMI
function Get-Arbol([int]$Raiz, $padres) {
  $ids = [System.Collections.Generic.HashSet[int]]::new([int[]]@($Raiz))
  $stack = [System.Collections.Generic.Stack[int]]::new([int[]]@($Raiz))
  while ($stack.Count -gt 0) {
    $c = $stack.Pop()
    foreach ($k in $padres.Keys) { if ($padres[$k] -eq $c -and $ids.Add($k)) { $stack.Push($k) } }
  }
  return @{ ids = $ids }
}

# MainWindowHandle distinto de 0 = proceso con ventana principal visible
function Get-PidVentana([int[]]$pids) {
  foreach ($id in $pids) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne 0) { return $id }
  }
  return $null
}

function Get-RamArbol([int]$Raiz) {
  $padres = Get-DiccionarioPadres
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  foreach ($p in $all) { $padres[[int]$p.ProcessId] = [int]$p.ParentProcessId }
  $ids = Get-Arbol $Raiz $padres
  return @(Get-Process -Id ([int[]]$ids.ids) -ErrorAction SilentlyContinue | Sort-Object PrivateMemorySize64 -Descending)
}

function Stop-Arbol([int]$Raiz) {
  $padres = Get-DiccionarioPadres
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  foreach ($p in $all) { $padres[[int]$p.ProcessId] = [int]$p.ParentProcessId }
  $ids = Get-Arbol $Raiz $padres
  foreach ($id in $ids.ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
}

function MedirRepeticion {
  $script:root = $null
  if ($script:FreshVar -and $script:FreshVar -ne "") {
    $script:root = Join-Path $script:FreshBase ([System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force $script:root | Out-Null
    Set-Item "Env:\$($script:FreshVar)" $script:root
  }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $raiz = (Start-Process -FilePath $Exe -PassThru).Id
  $pidVentana = $null
  $limite = [DateTime]::Now.AddSeconds(90)
  $ultimaLista = [DateTime]::Now.AddMilliseconds(-500)
  $pidsArbol = [int[]]$raiz
  while ([DateTime]::Now -lt $limite) {
    if (([DateTime]::Now - $ultimaLista).TotalMilliseconds -ge 500) {
      $padres = Get-DiccionarioPadres
      $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
      foreach ($p in $all) { $padres[[int]$p.ProcessId] = [int]$p.ParentProcessId }
      $pidsArbol = [int[]](Get-Arbol $raiz $padres).ids
      $ultimaLista = [DateTime]::Now
    }
    $pidVentana = Get-PidVentana $pidsArbol
    if ($pidVentana) { break }
    Start-Sleep -Milliseconds 15
  }
  $boot = if ($pidVentana) { [math]::Round($sw.ElapsedMilliseconds) } else { -1 }
  Start-Sleep -Seconds 30
  $ram = Get-RamArbol $raiz
  $total = if ($ram.Count) { [math]::Round((($ram | Measure-Object -Property PrivateMemorySize64 -Sum).Sum) / 1MB, 1) } else { 0 }
  $filas = ($ram | ForEach-Object { "{0}:{1:n1}" -f $_.ProcessName, ($_.PrivateMemorySize64 / 1MB) }) -join " "
  Stop-Arbol $raiz
  if ($script:root) {
    Start-Sleep -Milliseconds 800
    Remove-Item $script:root -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item "Env:\$($script:FreshVar)" -ErrorAction SilentlyContinue
  }
  [PSCustomObject]@{ boot_ms = $boot; ram_mb = $total; filas = $filas }
}

if ($Warmup) { $w = MedirRepeticion; Write-Output "$Label warmup boot=$($w.boot_ms) ram=$($w.ram_mb)" }
for ($i = 1; $i -le $Reps; $i++) {
  $r = MedirRepeticion
  Write-Output "$Label rep$i boot_ms=$($r.boot_ms) ram_mb=$($r.ram_mb) filas=$($r.filas)"
}
