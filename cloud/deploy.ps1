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
  $apiBody = @{
    identifierUris = @("api://$api")
    signInAudience = 'AzureADMyOrg'
    api = @{
      requestedAccessTokenVersion = 2
      oauth2PermissionScopes = @(@{
        adminConsentDisplayName = 'Access Yogurt notes'
        adminConsentDescription = 'Upload meeting audio and read your own transcripts and summaries.'
        id = $scopeId
        isEnabled = $true
        type = 'User'
        userConsentDisplayName = 'Access your Yogurt notes'
        userConsentDescription = 'Upload meeting audio and read your transcripts and summaries.'
        value = 'access_as_user'
      })
      preAuthorizedApplications = @(@{ appId = $desktop; delegatedPermissionIds = @($scopeId) })
    }
  } | ConvertTo-Json -Depth 8
  $apiFile = Join-Path $env:TEMP 'yogurt-api-app.json'
  [System.IO.File]::WriteAllText($apiFile, $apiBody)
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
  $assignment = @{ principalId = $group; resourceId = $apiSp; appRoleId = '00000000-0000-0000-0000-000000000000' } | ConvertTo-Json -Compress
  $assignFile = Join-Path $env:TEMP 'yogurt-group-assign.json'
  [System.IO.File]::WriteAllText($assignFile, $assignment)
  az rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$apiSp/appRoleAssignedTo" --headers 'Content-Type=application/json' --body "@$assignFile" 1>$null 2>$null
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
$common = @(
  'location=' + $Location,
  'openAiLocation=' + $OpenAiLocation,
  'speechLocation=' + $SpeechLocation,
  'namePrefix=' + $NamePrefix,
  'sqlServerName=' + $SqlServerName,
  'sqlDatabaseName=' + $SqlDatabaseName,
  'sqlResourceGroup=' + $SqlResourceGroup,
  'sqlSubscriptionId=' + $SqlSubscriptionId,
  'entraTenantId=' + $TenantId,
  'entraApiAudience=' + $ApiAudience,
  'entraAllowedClientId=' + $DesktopClientId
)

function Deploy-Pilot {
  param([bool]$Events)
  $flag = 'includeEventSubscription=false'
  if ($Events) { $flag = 'includeEventSubscription=true' }
  $params = @($common) + $flag
  & az deployment group create --name yogurt-pilot --resource-group $ResourceGroup --template-file $bicep --parameters @params
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
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip

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
