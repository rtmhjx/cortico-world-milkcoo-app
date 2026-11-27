param([string]$CorticoRoot = 'F:\AI\C\cortico')
$ErrorActionPreference = 'Stop'
$checkout = (Resolve-Path -LiteralPath $CorticoRoot).Path
$worldRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$tag = [Guid]::NewGuid().ToString('N')
$testPath = Join-Path $checkout "tests\core\z-coo-fixture-$tag.test.ts"
$configPath = Join-Path $checkout "z-coo-vitest-$tag.mjs"
$shimName = "z-coo-sqlite-$tag.mjs"
$shimPath = Join-Path $checkout $shimName
foreach ($candidate in @($testPath,$configPath,$shimPath)) {
    if (Test-Path -LiteralPath $candidate) { throw 'Refuse to overwrite an existing fixture file.' }
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'real-core-fixture.test.ts') -Destination $testPath
@'
import { createRequire } from 'node:module';
export const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
'@ | Set-Content -LiteralPath $shimPath -Encoding utf8
$config = @'
import base from './vitest.config.ts';
import { fileURLToPath } from 'node:url';
export default { ...base, resolve: { ...base.resolve, alias: [{ find: 'node:sqlite', replacement: fileURLToPath(new URL('./__SHIM__',import.meta.url)) }, ...(base.resolve?.alias ?? [])] } };
'@
$config.Replace('__SHIM__',$shimName) | Set-Content -LiteralPath $configPath -Encoding utf8
$env:COO_TEST_CORTICO_ROOT = $checkout
$env:COO_TEST_WORLD_SOURCE = Join-Path $worldRoot 'src\world.mjs'
Push-Location $checkout
try {
    & (Join-Path $checkout 'node_modules\.bin\vitest.cmd') run $testPath --config $configPath --reporter=verbose
    $result = $LASTEXITCODE
} finally {
    Pop-Location
    Remove-Item -LiteralPath $testPath,$configPath,$shimPath
}
exit $result
