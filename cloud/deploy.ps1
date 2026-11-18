# Preferred by Nature pilot. Run from Windows with the Azure CLI:
#   pwsh -File cloud/deploy.ps1 -SqlDatabaseName <existing-db> -CreateEntraApps -PilotUserUpns user1@pbn.org,user2@pbn.org
# Requires: az (logged in, or this script runs az login), Node.js, pnpm, npm.
# Does not deploy into rg-dat-bui-asana. SQL stays where it is.
#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SqlDatabaseName,
  [string]$SubscriptionId = '18221f37-3034-427f-a822-284fa053a35d',
  [string]$TenantId = '6a94fd93-b4dc-42db-9712-8defab2a3e93',
  [string]$Location = 'northeurope',
  [string]$OpenAiLocation = 'swedencentral',
  [string]$SpeechLocation = 'northeurope',
  [string]$ResourceGroup = 'rg-yogurt-pilot',
  [string]$SqlServerName = 'sql-external-landing-pbn',
  [string]$SqlResourceGroup = 'rg-dat-bui-asana',
  [string]$SqlSubscriptionId = '',
  [string]$NamePrefix = 'yogurt-pilot',
  [string]$ApiAudience = '',
  [string]$DesktopClientId = '',
  [switch]$CreateEntraApps,
  [string[]]$PilotUserUpns = @()
)

$ErrorActionPreference = 'Stop'
if ($ResourceGroup -eq $SqlResourceGroup) {
  throw "Refusing to deploy into $SqlResourceGroup. The pilot resource group is $ResourceGroup. SQL is only granted access afterwards."
}

function Invoke-Az {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$AzArgs)
  & az @AzArgs
  if ($LASTEXITCODE -ne 0) { throw "az $($AzArgs -join ' ') failed" }
}

function Write-JsonFile {
  param([string]$Path, [string]$Json)
  [System.IO.File]::WriteAllText($Path, $Json)
}

# Graph rejects preAuthorizedApplications in the same PATCH that creates the scope.
function Write-ApiScopeJson {
  param([string]$Path, [string]$ApiAppId, [string]$ScopeGuid, [string]$DesktopAppId, [bool]$PreAuthorize)
  $pre = ''
  if ($PreAuthorize) {
    $pre = @"
,
      "preAuthorizedApplications": [
        { "appId": "$DesktopAppId", "delegatedPermissionIds": ["$ScopeGuid"] }
      ]
"@
  }
  $json = @"
{
  "identifierUris": ["api://$ApiAppId"],
  "signInAudience": "AzureADMyOrg",
  "api": {
    "requestedAccessTokenVersion": 2,
    "oauth2PermissionScopes": [
      {
        "adminConsentDisplayName": "Access Yogurt notes",
        "adminConsentDescription": "Upload meeting audio and read your own transcripts and summaries.",
        "id": "$ScopeGuid",
        "isEnabled": true,
        "type": "User",
        "userConsentDisplayName": "Access your Yogurt notes",
        "userConsentDescription": "Upload meeting audio and read your transcripts and summaries.",
        "value": "access_as_user"
      }
    ]$pre
  }
}
"@
  Write-JsonFile -Path $Path -Json $json
}

function Grant-PilotGroup {
  param([string]$ResourceSpId, [string]$GroupId)
  $file = Join-Path $env:TEMP "yogurt-assign-$ResourceSpId.json"
  Write-JsonFile -Path $file -Json "{`"principalId`":`"$GroupId`",`"resourceId`":`"$ResourceSpId`",`"appRoleId`":`"00000000-0000-0000-0000-000000000000`"}"
  & az rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$ResourceSpId/appRoleAssignedTo" --headers 'Content-Type=application/json' --body "@$file"
  if ($LASTEXITCODE -ne 0) { Write-Warning "Yogurt Pilot is already assigned to $ResourceSpId, or the assignment failed." }
}

function Write-BicepParameters {
  param([string]$Path, [bool]$Events)
  $eventsJson = 'false'
  if ($Events) { $eventsJson = 'true' }
  $json = @"
{
  "`$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "location": { "value": "$Location" },
    "openAiLocation": { "value": "$OpenAiLocation" },
    "speechLocation": { "value": "$SpeechLocation" },
    "namePrefix": { "value": "$NamePrefix" },
    "sqlServerName": { "value": "$SqlServerName" },
    "sqlDatabaseName": { "value": "$SqlDatabaseName" },
    "sqlResourceGroup": { "value": "$SqlResourceGroup" },
    "sqlSubscriptionId": { "value": "$SqlSubscriptionId" },
    "entraTenantId": { "value": "$TenantId" },
    "entraApiAudience": { "value": "$ApiAudience" },
    "entraAllowedClientId": { "value": "$DesktopClientId" },
    "includeEventSubscription": { "value": $eventsJson }
  }
}
"@
  Write-JsonFile -Path $Path -Json $json
}

# Compress-Archive stores backslashes. Azure's host wants forward slashes.
function Compress-ForwardSlashZip {
  param([string]$Source, [string]$Destination)
  if (Test-Path $Destination) { Remove-Item $Destination -Force }
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path $tar) {
    Push-Location $Source
    try {
      & $tar -a -c -f $Destination *
      if ($LASTEXITCODE -eq 0) { return }
      Write-Warning "tar.exe failed ($LASTEXITCODE); zipping with forward-slash entry names instead."
    } finally { Pop-Location }
    if (Test-Path $Destination) { Remove-Item $Destination -Force }
  }
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::Open($Destination, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    $root = (Resolve-Path $Source).Path.TrimEnd('\', '/')
    Get-ChildItem -Path $root -Recurse -File | ForEach-Object {
      $name = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $name)
    }
  } finally { $archive.Dispose() }
}

Write-Host "Using subscription $SubscriptionId in tenant $TenantId"
az account show --query id -o tsv 1>$null 2>$null
if ($LASTEXITCODE -ne 0) { Invoke-Az login --tenant $TenantId }
Invoke-Az account set --subscription $SubscriptionId

$cloud = $PSScriptRoot
$repo = Split-Path $cloud -Parent
$scopeId = $null

if ($CreateEntraApps) {
  Write-Host 'Creating or reusing the desktop and API app registrations'
  $desktop = az ad app list --display-name 'Yogurt Pilot Desktop' --query '[0].appId' -o tsv
  if (-not $desktop) {
    $desktop = az ad app create --display-name 'Yogurt Pilot Desktop' --sign-in-audience AzureADMyOrg --query appId -o tsv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the desktop app registration' }
  }
  $desktopObject = az ad app show --id $desktop --query id -o tsv
  $desktopBody = '{"publicClient":{"redirectUris":["http://localhost"]},"isFallbackPublicClient":true,"signInAudience":"AzureADMyOrg"}'
  $desktopFile = Join-Path $env:TEMP 'yogurt-desktop-app.json'
  [System.IO.File]::WriteAllText($desktopFile, $desktopBody)
  Invoke-Az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$desktopObject" --headers 'Content-Type=application/json' --body "@$desktopFile"

  $api = az ad app list --display-name 'Yogurt Pilot API' --query '[0].appId' -o tsv
  if (-not $api) {
    $api = az ad app create --display-name 'Yogurt Pilot API' --sign-in-audience AzureADMyOrg --query appId -o tsv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the API app registration' }
  }
  $apiObject = az ad app show --id $api --query id -o tsv
  $existingScope = az ad app show --id $api --query "api.oauth2PermissionScopes[?value=='access_as_user'].id | [0]" -o tsv
  if ($existingScope) { $scopeId = $existingScope } else { $scopeId = [guid]::NewGuid().ToString() }
  $apiFile = Join-Path $env:TEMP 'yogurt-api-app.json'
  Write-ApiScopeJson -Path $apiFile -ApiAppId $api -ScopeGuid $scopeId -DesktopAppId $desktop -PreAuthorize $false
  Invoke-Az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$apiObject" --headers 'Content-Type=application/json' --body "@$apiFile"
  Write-ApiScopeJson -Path $apiFile -ApiAppId $api -ScopeGuid $scopeId -DesktopAppId $desktop -PreAuthorize $true
  Invoke-Az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$apiObject" --headers 'Content-Type=application/json' --body "@$apiFile"
  az ad app permission add --id $desktop --api $api --api-permissions "$scopeId=Scope"
  if ($LASTEXITCODE -ne 0) { Write-Warning 'The desktop app already has the API permission, or it could not be added.' }
  az ad app permission admin-consent --id $desktop
  if ($LASTEXITCODE -ne 0) { Write-Warning 'Admin consent did not complete. A tenant admin should grant it in Entra.' }

  $desktopSp = az ad sp list --filter "appId eq '$desktop'" --query '[0].id' -o tsv
  if (-not $desktopSp) { $desktopSp = az ad sp create --id $desktop --query id -o tsv }
  $apiSp = az ad sp list --filter "appId eq '$api'" --query '[0].id' -o tsv
  if (-not $apiSp) { $apiSp = az ad sp create --id $api --query id -o tsv }
  Invoke-Az ad sp update --id $desktopSp --set appRoleAssignmentRequired=true
  Invoke-Az ad sp update --id $apiSp --set appRoleAssignmentRequired=true

  $group = az ad group list --filter "displayName eq 'Yogurt Pilot'" --query '[0].id' -o tsv
  if (-not $group) {
    $group = az ad group create --display-name 'Yogurt Pilot' --mail-nickname 'yogurt-pilot' --query id -o tsv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Yogurt Pilot security group' }
  }
  Grant-PilotGroup -ResourceSpId $apiSp -GroupId $group
  Grant-PilotGroup -ResourceSpId $desktopSp -GroupId $group
  foreach ($upn in $PilotUserUpns) {
    $member = az ad user show --id $upn --query id -o tsv
    if ($LASTEXITCODE -ne 0) { throw "No Entra user $upn" }
    az ad group member add --group $group --member-id $member
    if ($LASTEXITCODE -ne 0) { Write-Warning "$upn is already in Yogurt Pilot, or could not be added." }
  }
  $DesktopClientId = $desktop
  $ApiAudience = "api://$api"
  Write-Host "Desktop client $DesktopClientId"
  Write-Host "API audience $ApiAudience"
}

if (-not $ApiAudience) { Write-Warning 'ENTRA_API_AUDIENCE is empty. Pass -ApiAudience or -CreateEntraApps before people can sign in.' }

Write-Host "Creating $ResourceGroup in $Location"
Invoke-Az group create --name $ResourceGroup --location $Location --tags project=yogurt-pilot customer=preferred-by-nature

$bicep = Join-Path $cloud 'infra\main.bicep'
$paramFile = Join-Path $env:TEMP 'yogurt-pilot.parameters.json'

function Deploy-Pilot {
  param([bool]$Events)
  Write-BicepParameters -Path $paramFile -Events $Events
  & az deployment group create --name yogurt-pilot --resource-group $ResourceGroup --template-file $bicep --parameters "@$paramFile"
  if ($LASTEXITCODE -ne 0) { throw 'Bicep deployment failed' }
}

Write-Host 'Deploying infrastructure (Event Grid subscription waits until the function code exists)'
Deploy-Pilot -Events $false

Write-Host 'Building the function'
Push-Location $repo
try {
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'pnpm is required (the repo uses pnpm 10.7)' }
  & pnpm install
  if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }
  & pnpm --filter @yogurt/cloud build
  if ($LASTEXITCODE -ne 0) { throw 'cloud build failed' }
} finally { Pop-Location }

$stage = Join-Path $env:TEMP 'yogurt-cloud-stage'
$zip = Join-Path $env:TEMP 'yogurt-cloud.zip'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item (Join-Path $cloud 'host.json') $stage
Copy-Item (Join-Path $cloud 'package.json') $stage
Copy-Item (Join-Path $cloud 'dist') (Join-Path $stage 'dist') -Recurse
Push-Location $stage
try {
  & npm install --omit=dev --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'npm install of function dependencies failed' }
} finally { Pop-Location }
Compress-ForwardSlashZip -Source $stage -Destination $zip

$functionName = az deployment group show --resource-group $ResourceGroup --name yogurt-pilot --query properties.outputs.functionAppName.value -o tsv
if ($LASTEXITCODE -ne 0 -or -not $functionName) { throw 'Could not read the function app name' }
Write-Host "Publishing $functionName"
Invoke-Az functionapp deployment source config-zip --resource-group $ResourceGroup --name $functionName --src $zip

Write-Host 'Subscribing Event Grid now that onAudioBlob is deployed'
Deploy-Pilot -Events $true

$outputs = az deployment group show --resource-group $ResourceGroup --name yogurt-pilot --query properties.outputs -o json | ConvertFrom-Json
$api = $outputs.apiBaseUrl.value
Write-Host 'Waiting for the API'
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $response = Invoke-WebRequest -Uri ($api + '/health') -UseBasicParsing -TimeoutSec 15
    if ($response.StatusCode -eq 200) { $healthy = $true; break }
  } catch { Start-Sleep -Seconds 10 }
}
if (-not $healthy) { Write-Warning "The API did not answer $api/health yet. Check the function logs, then retry." }

$principal = $outputs.functionPrincipalId.value
Write-Host ''
Write-Host 'App configuration (per user, or as environment variables):'
Write-Host "YOGURT_CLOUD=1"
Write-Host "YOGURT_ENTRA_TENANT_ID=$TenantId"
Write-Host "YOGURT_ENTRA_CLIENT_ID=$DesktopClientId"
Write-Host "YOGURT_ENTRA_API_SCOPE=$ApiAudience/access_as_user"
Write-Host "YOGURT_CLOUD_API_URL=$api"
Write-Host ''
Write-Host "OpenAI is in $($outputs.openAiLocation.value) because gpt-5-mini Global Standard is not offered in $($outputs.location.value)."
Write-Host "Speech is in $($outputs.speechLocation.value). Audio blobs stay in $($outputs.location.value) and are deleted after 30 days."
Write-Host "Function principal: $principal"
Write-Host "Key Vault (no secret is required for this pilot): $($outputs.keyVaultName.value)"
Write-Host ''
Write-Host "Run cloud/sql/001_notes.sql on $($outputs.sqlServerFqdn.value) database $($outputs.sqlDatabaseName.value)."
Write-Host "That server is in resource group $($outputs.sqlResourceGroup.value). This script did not deploy there."
if ($outputs.sqlSubscriptionId.value) { Write-Host "SQL subscription: $($outputs.sqlSubscriptionId.value)" }
Write-Host 'Then run these two statements as the Entra admin of that database:'
Write-Host "CREATE USER [$functionName] FROM EXTERNAL PROVIDER;"
Write-Host "ALTER ROLE notes_app ADD MEMBER [$functionName];"
Write-Host 'Allow Azure services on the SQL firewall. Do not add the function to db_owner.'
Write-Host 'Add the five pilot users to the Entra group "Yogurt Pilot" if they were not passed as -PilotUserUpns.'
