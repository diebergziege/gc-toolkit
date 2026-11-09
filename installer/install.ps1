# Installs the Genesys Cloud Toolkit (gctk) on Windows, with its own Node.js: nothing needs to be
# installed first and no admin rights are needed. Double-click "Install gctk.cmd", or in PowerShell:
#   irm https://github.com/diebergziege/gc-toolkit/releases/latest/download/install.ps1 | iex
#   $env:GCTK_EDITION = 'partner'; irm ... | iex      (gctk Partner: only the Partner page)
# Running it again updates gctk and its Node.js. Your orgs and settings stay.

function Install-Gctk {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $DefaultEdition = 'full'
  $Edition = if ($env:GCTK_EDITION) { $env:GCTK_EDITION } else { $DefaultEdition }
  $NodeLine = 24
  $Repo = 'https://github.com/diebergziege/gc-toolkit'
  $GctkDir = if ($env:GCTK_HOME) { $env:GCTK_HOME } elseif ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME 'gctk' } else { Join-Path $env:USERPROFILE '.config\gctk' }
  $NodeDir = Join-Path $GctkDir 'node'
  $Node = Join-Path $NodeDir 'node.exe'
  $Name = if ($Edition -eq 'partner') { 'gctk Partner' } else { 'gctk' }

  Write-Host "Installing $Name (Genesys Cloud Toolkit). This takes a minute or two."
  Write-Host ''

  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $Arch = switch ($arch) { 'ARM64' { 'arm64' } 'AMD64' { 'x64' } default { throw "this computer's processor ($arch) is not supported." } }

  $Tmp = Join-Path ([IO.Path]::GetTempPath()) ("gctk-install-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $Tmp | Out-Null
  try {
    # 1. Node.js: the newest release of the LTS line, checked against nodejs.org's checksums.
    Write-Host '1/3  Node.js'
    $base = "https://nodejs.org/dist/latest-v$NodeLine.x"
    try { $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content }
    catch { throw 'nodejs.org could not be reached. Check the internet connection (or VPN) and try again.' }
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
    $line = $sums -split "`n" | Where-Object { $_ -match " (node-v[0-9.]+-win-$Arch\.zip)\s*$" } | Select-Object -First 1
    if (-not $line) { throw "nodejs.org has no Node.js for win-$Arch." }
    $want, $file = ($line.Trim() -split '\s+')
    $version = $file -replace '^node-(v[0-9.]+)-.*$', '$1'
    $have = if (Test-Path $Node) { try { (& $Node --version) 2>$null } catch { '' } } else { '' }
    if ($have -eq $version) {
      Write-Host "     Node.js $version is there already."
    } else {
      Write-Host "     Downloading Node.js $version ..."
      $zip = Join-Path $Tmp $file
      try { Invoke-WebRequest -UseBasicParsing -OutFile $zip "$base/$file" }
      catch { throw 'the download of Node.js stopped. Try again.' }
      if ((Get-FileHash -Algorithm SHA256 $zip).Hash -ne $want) { throw 'the Node.js download is damaged (checksum differs). Try again.' }
      Expand-Archive -Path $zip -DestinationPath $Tmp -Force
      # A running gctk keeps node.exe locked: stop it, and move the old file aside if it is still in use.
      $appJs = Join-Path $GctkDir 'app\dist\gctk.js'
      if ((Test-Path $Node) -and (Test-Path $appJs)) { try { & $Node $appJs ui --stop | Out-Null } catch {} }
      New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null
      if (Test-Path $Node) {
        $old = Join-Path $NodeDir 'node.old.exe'
        Remove-Item -Force $old -ErrorAction SilentlyContinue
        Move-Item -Force $Node $old
      }
      Copy-Item -Force (Join-Path (Join-Path $Tmp ($file -replace '\.zip$', '')) 'node.exe') $Node
      Write-Host "     Node.js $version is ready."
    }

    # 2. gctk: the newest version from GitHub.
    Write-Host '2/3  gctk'
    if ($env:GCTK_INSTALL_FROM) {
      $js = Join-Path $env:GCTK_INSTALL_FROM 'dist\gctk.js' # a checkout or build of gctk (testing the installer)
    } else {
      $src = Join-Path $Tmp 'gctk'
      try { Invoke-WebRequest -UseBasicParsing -OutFile (Join-Path $Tmp 'gctk.zip') "$Repo/archive/refs/heads/main.zip" }
      catch { throw 'github.com could not be reached. Check the internet connection (or VPN) and try again.' }
      Expand-Archive -Path (Join-Path $Tmp 'gctk.zip') -DestinationPath $src -Force
      $top = Get-ChildItem -Directory $src | Select-Object -First 1
      $js = Join-Path $top.FullName 'dist\gctk.js'
    }
    if (-not (Test-Path $js)) { throw "GitHub's download holds no gctk." }

    # 3. The app to click, the gctk command and the first start.
    Write-Host "3/3  Setting up $Name"
    & $Node $js install --edition $Edition
    if ($LASTEXITCODE -ne 0) { throw 'the setup stopped (see the lines above).' }

    Write-Host ''
    Write-Host "Done. $Name opened in your browser." -ForegroundColor Green
    Write-Host "Next time, open `"$Name`" from the Start menu or the Desktop."
    Write-Host 'You can close this window.'
  } finally {
    Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
  }
}

try { Install-Gctk }
catch {
  Write-Host ''
  Write-Host "Installing gctk did not work: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'You can run the installer again; it picks up where it stopped.'
  Write-Host 'If it keeps failing, send a screenshot of this window to whoever sent you the download.'
}
