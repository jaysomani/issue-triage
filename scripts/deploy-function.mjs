// Creates or updates the triage function and deploys its code. Usage: node deploy-function.mjs
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AppwriteException, Client, Functions, ProjectKeyScopes, Role, Runtime } from 'node-appwrite'
import { InputFile } from 'node-appwrite/file'
import { env } from './client.mjs'

const FUNCTION_ID = 'triage'
const functionsDir = fileURLToPath(new URL('../functions', import.meta.url))
const archive = fileURLToPath(new URL('../functions/triage.tar.gz', import.meta.url))

const functions = new Functions(
  new Client()
    .setEndpoint(env('APPWRITE_ENDPOINT'))
    .setProject(env('APPWRITE_PROJECT_ID'))
    .setKey(env('APPWRITE_API_KEY')),
)

const settings = {
  functionId: FUNCTION_ID,
  name: 'Triage',
  runtime: Runtime.Node22,
  // Anyone may run it: the dashboard checks and reviews issues, and GitHub sends webhooks
  execute: [Role.any()],
  timeout: 30,
  entrypoint: 'src/main.js',
  commands: 'npm install --omit=dev',
  scopes: [
    ProjectKeyScopes.RowsRead,
    ProjectKeyScopes.RowsWrite,
    ProjectKeyScopes.EmbeddingsWrite,
    ProjectKeyScopes.VectorsdbDocumentsRead,
    ProjectKeyScopes.VectorsdbDocumentsWrite,
  ],
}

try {
  await functions.update(settings)
  console.log('updated function')
} catch (error) {
  if (!(error instanceof AppwriteException && error.code === 404)) throw error
  await functions.create(settings)
  console.log('created function')
}

try {
  await functions.createVariable({
    functionId: FUNCTION_ID,
    variableId: 'GITHUB_WEBHOOK_SECRET',
    key: 'GITHUB_WEBHOOK_SECRET',
    value: env('GITHUB_WEBHOOK_SECRET'),
    secret: true,
  })
} catch (error) {
  if (!(error instanceof AppwriteException && error.code === 409)) throw error
}

// Relative paths, because GNU tar reads a Windows drive letter as a remote host
execFileSync('tar', ['-czf', 'triage.tar.gz', '--exclude=node_modules', '-C', 'triage', '.'], {
  cwd: functionsDir,
})

const deployment = await functions.createDeployment({
  functionId: FUNCTION_ID,
  code: InputFile.fromPath(archive, 'triage.tar.gz'),
  activate: true,
})
console.log(`deployment ${deployment.$id} is ${deployment.status}`)

for (let attempt = 0; attempt < 120; attempt++) {
  const { status } = await functions.getDeployment({ functionId: FUNCTION_ID, deploymentId: deployment.$id })
  if (status === 'ready') {
    console.log('deployment ready')
    process.exit(0)
  }
  if (status === 'failed' || status === 'canceled') throw new Error(`deployment ${status}`)
  await new Promise((resolve) => setTimeout(resolve, 3000))
}
throw new Error('deployment did not finish in time')
