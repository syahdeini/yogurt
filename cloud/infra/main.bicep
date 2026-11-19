// Preferred by Nature pilot. Deploys into rg-yogurt-pilot only.
// The existing SQL server (sql-external-landing-pbn / rg-dat-bui-asana) is never created or changed here,
// even when it lives in another subscription. Pass its names so the function can connect, then grant
// the function identity with cloud/sql/001_notes.sql.
//
// gpt-5-mini Global Standard is not offered in northeurope (North Europe has no Global Standard
// deployment for that model). openAiLocation defaults to swedencentral, where Global Standard is offered.
// Speech batch transcription, including diarization, is offered in northeurope, so the Speech resource
// stays with the rest of the pilot. If a deploy error says Speech cannot be created there, set
// speechLocation to swedencentral.

@description('Region for the function app, storage, Key Vault, Event Grid, Speech and App Insights.')
param location string = 'northeurope'

@description('Region for the Azure OpenAI account. gpt-5-mini Global Standard is not in northeurope; Sweden Central is.')
param openAiLocation string = 'swedencentral'

@description('Region for Azure AI Speech. Batch transcription is available in northeurope. Use swedencentral if a deploy error says otherwise.')
param speechLocation string = 'northeurope'

@description('Short name used in resource names. Must stay unique for storage, Key Vault and OpenAI.')
@minLength(3)
@maxLength(16)
param namePrefix string = 'yogurt-pilot'

@description('Existing Azure SQL server name. Not created.')
param sqlServerName string = 'sql-external-landing-pbn'

@description('Existing database on that server. Not created.')
@minLength(1)
param sqlDatabaseName string

@description('Resource group of the existing SQL server. Nothing is deployed into it.')
param sqlResourceGroup string = 'rg-dat-bui-asana'

@description('Subscription id of the existing SQL server when it is not the pilot subscription. Informational only.')
param sqlSubscriptionId string = ''

@description('Entra tenant that signs the desktop app in. Single tenant.')
param entraTenantId string = '6a94fd93-b4dc-42db-9712-8defab2a3e93'

@description('Accepted token audiences, comma-separated. Usually api://<api-app-id>.')
param entraApiAudience string = ''

@description('Desktop app registration client id. Tokens from other clients are rejected when this is set.')
param entraAllowedClientId string = ''

@description('Create the Event Grid subscription. Turn this on after the function code is published, so the function exists.')
param includeEventSubscription bool = false

@description('Global Standard throughput for each model (gpt-5, gpt-5-mini), in thousands of tokens per minute. Pay-as-you-go, not reserved.')
param openAiCapacity int = 50

var compact = toLower(replace(namePrefix, '-', ''))
var storageName = 'st${compact}pbn'
var keyVaultName = 'kv-${namePrefix}'
var functionName = 'func-${namePrefix}'
var planName = 'plan-${namePrefix}'
var speechName = 'speech-${compact}'
var openAiName = 'oai-${compact}'
var appInsightsName = 'appi-${namePrefix}'
var logName = 'log-${namePrefix}'
var sqlServerFqdn = '${sqlServerName}${environment().suffixes.sqlServerHostname}'
var containerName = 'audio'
var deployContainer = 'deployments'
var tags = { project: 'yogurt-pilot', customer: 'preferred-by-nature' }

var blobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var blobDelegator = 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'
var queueDataContributor = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
var tableDataContributor = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'
var cognitiveServicesUser = 'a97b65f3-24c7-4388-baec-2e87135dc908'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logName
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    IngestionMode: 'LogAnalytics'
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Enabled'
    accessTier: 'Hot'
  }
}

resource blobServices 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  resource audio 'containers' = {
    name: containerName
    properties: { publicAccess: 'None' }
  }
  resource deployments 'containers' = {
    name: deployContainer
    properties: { publicAccess: 'None' }
  }
}

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          enabled: true
          name: 'delete-audio-after-30-days'
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [ 'blockBlob' ]
              prefixMatch: [ '${containerName}/' ]
            }
            actions: {
              baseBlob: { delete: { daysAfterModificationGreaterThan: 30 } }
            }
          }
        }
      ]
    }
  }
}

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: planName
  location: location
  tags: tags
  kind: 'functionapp'
  sku: { tier: 'FlexConsumption', name: 'FC1' }
  properties: { reserved: true }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
    sku: { family: 'A', name: 'standard' }
  }
}

resource speech 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: speechName
  location: speechLocation
  tags: tags
  kind: 'SpeechServices'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: speechName
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: true
    networkAcls: { defaultAction: 'Allow' }
  }
}

resource openai 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: openAiName
  location: openAiLocation
  tags: tags
  kind: 'AIServices'
  sku: { name: 'S0' }
  properties: {
    customSubDomainName: openAiName
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: true
    networkAcls: { defaultAction: 'Allow' }
  }
}

resource gpt5mini 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openai
  name: 'gpt-5-mini'
  sku: { name: 'GlobalStandard', capacity: openAiCapacity }
  properties: {
    model: { format: 'OpenAI', name: 'gpt-5-mini', version: '2025-08-07' }
  }
}

// The summary model. gpt-5-mini stays deployed as a cheap fallback (set AZURE_OPENAI_DEPLOYMENT back to it).
resource gpt5 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openai
  name: 'gpt-5'
  sku: { name: 'GlobalStandard', capacity: openAiCapacity }
  properties: {
    model: { format: 'OpenAI', name: 'gpt-5', version: '2025-08-07' }
  }
  dependsOn: [ gpt5mini ]
}

resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: functionName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    siteConfig: { minTlsVersion: '1.2' }
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${deployContainer}'
          authentication: { type: 'SystemAssignedIdentity' }
        }
      }
      scaleAndConcurrency: { maximumInstanceCount: 20, instanceMemoryMB: 2048 }
      runtime: { name: 'node', version: '20' }
    }
  }
  dependsOn: [ blobServices ]
}

resource appSettings 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: functionApp
  name: 'appsettings'
  properties: {
    AzureWebJobsStorage__accountName: storage.name
    AzureWebJobsStorage__credential: 'managedidentity'
    APPLICATIONINSIGHTS_CONNECTION_STRING: appInsights.properties.ConnectionString
    ENTRA_TENANT_ID: entraTenantId
    ENTRA_API_AUDIENCE: entraApiAudience
    ENTRA_ALLOWED_CLIENT_ID: entraAllowedClientId
    SQL_SERVER: sqlServerFqdn
    SQL_DATABASE: sqlDatabaseName
    STORAGE_ACCOUNT_NAME: storage.name
    STORAGE_CONTAINER: containerName
    SPEECH_ENDPOINT: speech.properties.endpoint
    AZURE_OPENAI_ENDPOINT: openai.properties.endpoint
    AZURE_OPENAI_DEPLOYMENT: 'gpt-5'
    SUMMARY_PROVIDER: 'azure-openai-gpt-5-mini'
  }
}

resource systemTopic 'Microsoft.EventGrid/systemTopics@2024-06-01-preview' = {
  name: '${storageName}-blob'
  location: location
  tags: tags
  properties: {
    source: storage.id
    topicType: 'Microsoft.Storage.StorageAccounts'
  }
}

resource audioCreated 'Microsoft.EventGrid/systemTopics/eventSubscriptions@2024-06-01-preview' = if (includeEventSubscription) {
  parent: systemTopic
  name: 'audio-created'
  properties: {
    destination: {
      endpointType: 'AzureFunction'
      properties: {
        resourceId: '${functionApp.id}/functions/onAudioBlob'
        maxEventsPerBatch: 1
        preferredBatchSizeInKilobytes: 64
      }
    }
    filter: {
      includedEventTypes: [ 'Microsoft.Storage.BlobCreated' ]
      subjectBeginsWith: '/blobServices/default/containers/${containerName}/blobs/'
    }
    retryPolicy: { maxDeliveryAttempts: 10, eventTimeToLiveInMinutes: 1440 }
    eventDeliverySchema: 'EventGridSchema'
  }
}

resource storageRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (role, i) in [
  blobDataContributor
  blobDelegator
  queueDataContributor
  tableDataContributor
]: {
  name: guid(storage.id, functionApp.id, role, string(i))
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', role)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}]

resource keyVaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, functionApp.id, keyVaultSecretsUser)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUser)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource speechRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(speech.id, functionApp.id, cognitiveServicesUser)
  scope: speech
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesUser)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource openaiRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(openai.id, functionApp.id, cognitiveServicesUser)
  scope: openai
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesUser)
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output functionAppName string = functionApp.name
output functionPrincipalId string = functionApp.identity.principalId
output apiBaseUrl string = 'https://${functionApp.properties.defaultHostName}/api'
output speechEndpoint string = speech.properties.endpoint
output openAiEndpoint string = openai.properties.endpoint
output openAiLocation string = openAiLocation
output speechLocation string = speechLocation
output location string = location
output storageAccountName string = storage.name
output keyVaultName string = keyVault.name
output sqlServerFqdn string = sqlServerFqdn
output sqlDatabaseName string = sqlDatabaseName
output sqlResourceGroup string = sqlResourceGroup
output sqlSubscriptionId string = sqlSubscriptionId
output gpt5miniDeployment string = gpt5mini.name
output eventSubscription string = includeEventSubscription ? 'audio-created' : ''
