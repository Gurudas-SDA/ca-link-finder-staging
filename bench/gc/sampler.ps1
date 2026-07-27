param([string]$Token, [int]$IntervalMs = 120)
# Long-lived dense sampler. The old proc-mem.ps1 was spawned per sample by
# execFileSync, which BLOCKS the node event loop — and the bench page awaits an
# exposed node function after every shard, so the shard loop ran at PowerShell
# cadence (~8.5 s/shard instead of ~0.5 s). That hands the GC a window
# production never gives it. This process streams samples instead.
# Emits: epochMs|rendererMB|treeMB
$ErrorActionPreference = 'SilentlyContinue'
$map = @{}
$lastMap = 0
while ($true) {
    $now = [int64]([datetime]::UtcNow - [datetime]'1970-01-01').TotalMilliseconds
    if ($now - $lastMap -gt 2000) {
        $lastMap = $now
        $all = Get-CimInstance Win32_Process -Filter "Name LIKE '%chrome%' OR Name LIKE '%headless%'"
        $root = 0
        foreach ($p in $all) {
            if ($p.CommandLine -like "*$Token*" -and $p.CommandLine -notlike '*--type=*') { $root = $p.ProcessId; break }
        }
        $map = @{}
        if ($root -ne 0) {
            $keep = @{}
            foreach ($p in $all) { if ($p.ProcessId -eq $root -or $p.ParentProcessId -eq $root) { $keep[$p.ProcessId] = $p } }
            foreach ($p in $all) { if ($keep.ContainsKey($p.ParentProcessId) -and -not $keep.ContainsKey($p.ProcessId)) { $keep[$p.ProcessId] = $p } }
            foreach ($p in $keep.Values) {
                $t = 'browser'
                if ($p.CommandLine -match '--type=([a-z-]+)') { $t = $Matches[1] }
                $map[[int]$p.ProcessId] = $t
            }
        }
    }
    $r = 0.0; $tot = 0.0
    foreach ($k in @($map.Keys)) {
        $proc = Get-Process -Id $k -ErrorAction SilentlyContinue
        if ($proc) {
            $ws = $proc.WorkingSet64 / 1MB
            $tot += $ws
            if ($map[$k] -eq 'renderer') { $r += $ws }
        }
    }
    [Console]::Out.WriteLine("$now|$([math]::Round($r,1))|$([math]::Round($tot,1))")
    [Console]::Out.Flush()
    Start-Sleep -Milliseconds $IntervalMs
}
