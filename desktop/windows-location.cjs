'use strict';
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

// Windows PowerShell carries the .NET Framework adapter for Windows Location.
const readPosition = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Device
$watcher = New-Object System.Device.Location.GeoCoordinateWatcher
try {
  $ready = $watcher.TryStart($false, [TimeSpan]::FromSeconds(12))
  $position = $watcher.Position
  if ($ready -and !$position.Location.IsUnknown -and
      $position.Timestamp -ge [DateTimeOffset]::Now.AddMinutes(-5)) {
    @{ lat=$position.Location.Latitude; lon=$position.Location.Longitude } | ConvertTo-Json -Compress
  } elseif ($watcher.Permission -eq 'Denied' -or $watcher.Status -eq 'Disabled') {
    '{"status":"denied"}'
  } else {
    '{"status":"unavailable"}'
  }
} finally { $watcher.Dispose() }
`;
let pending;
function locateWindows() {
  if (!pending) {
    const exe = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    pending = execute(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', readPosition], {
      timeout: 18000,
      windowsHide: true,
      maxBuffer: 16384,
    })
      .then(({ stdout }) => JSON.parse(stdout.trim()))
      .catch(() => ({ status: 'unavailable' }))
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}
module.exports = { locateWindows };
