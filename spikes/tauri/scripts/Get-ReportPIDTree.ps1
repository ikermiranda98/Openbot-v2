# Suma la RAM privada (commit) del árbol completo de procesos que cuelga de un
# pid: en Tauri incluye msedgewebview2.exe; en Electron los procesos hijos del
# main. Salidas: total en MB y tabla por proceso.
# Uso: .\Get-ReportPIDTree.ps1 -RootPID 1234
param([Parameter(Mandatory = $true)][int]$RootPID)

$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$ids = [System.Collections.Generic.HashSet[int]]::new()
$stack = [System.Collections.Generic.Stack[int]]::new()
$stack.Push($RootPID)
while ($stack.Count -gt 0) {
  $cur = $stack.Pop()
  if (-not $ids.Add($cur)) { continue }
  foreach ($p in $all | Where-Object { $_.ParentProcessId -eq $cur }) { $stack.Push([int]$p.ProcessId) }
}

$procs = Get-Process -Id ($ids.ToArray()) -ErrorAction SilentlyContinue
if (-not $procs) { Write-Output "0 MB (arbol vacio o ya muerto)"; return }

$total = [math]::Round((($procs | Measure-Object -Property PrivateMemorySize64 -Sum).Sum) / 1MB, 1)
Write-Output "TOTAL: $total MB"
$procs |
  Sort-Object PrivateMemorySize64 -Descending |
  Format-Table Id, ProcessName, @{ name = 'MB'; expression = { [math]::Round($_.PrivateMemorySize64 / 1MB, 1) } } -AutoSize |
  Out-String | Write-Output
