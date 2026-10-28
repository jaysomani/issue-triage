// Creates or updates the dashboard site on Appwrite Sites and deploys it. Usage: node deploy-site.mjs
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Adapter, AppwriteException, BuildRuntime, Client, Framework, Sites } from 'node-appwrite'
import { InputFile } from 'node-appwrite/file'
import { env } from './client.mjs'

const SITE_ID = 'triage-dashboard'
const root = fileURLToPath(new URL('..', import.meta.url))
const archive = fileURLToPath(new URL('../web.tar.gz', import.meta.url))

const sites = new Sites(
  new Client()
    .setEndpoint(env('APPWRITE_ENDPOINT'))
    .setProject(env('APPWRITE_PROJECT_ID'))
    .setKey(env('APPWRITE_API_KEY')),
)

const settings = {
  siteId: SITE_ID,
  name: 'Triage dashboard',
  framework: Framework.Vite,
  buildRuntime: BuildRuntime.Node22,
  installCommand: 'npm install',
  buildCommand: 'npm run build',
  outputDirectory: './dist',
  adapter: Adapter.Static,
  fallbackFile: 'index.html',
}

try {
  await sites.update(settings)
  console.log('updated site')
} catch (error) {
  if (!(error instanceof AppwriteException && error.code === 404)) throw error
  await sites.create(settings)
  console.log('created site')
}

// The dashboard reads these at build time
const variables = {
  VITE_APPWRITE_ENDPOINT: env('APPWRITE_ENDPOINT'),
  VITE_APPWRITE_PROJECT_ID: env('APPWRITE_PROJECT_ID'),
  VITE_GITHUB_REPO: env('GITHUB_REPO'),
}
const { variables: existing } = await sites.listVariables({ siteId: SITE_ID })
for (const [key, value] of Object.entries(variables)) {
  const current = existing.find((variable) => variable.key === key)
  if (current) {
    await sites.updateVariable({ siteId: SITE_ID, variableId: current.$id, key, value })
  } else {
    await sites.createVariable({ siteId: SITE_ID, variableId: key.toLowerCase().replaceAll('_', '-'), key, value })
  }
}

// Relative paths, because GNU tar reads a Windows drive letter as a remote host
execFileSync(
  'tar',
  ['-czf', 'web.tar.gz', '--exclude=node_modules', '--exclude=dist', '--exclude=.env', '-C', 'web', '.'],
  { cwd: root },
)

const deployment = await sites.createDeployment({
  siteId: SITE_ID,
  code: InputFile.fromPath(archive, 'web.tar.gz'),
  activate: true,
})
console.log(`deployment ${deployment.$id} is ${deployment.status}`)

for (let attempt = 0; attempt < 200; attempt++) {
  const { status } = await sites.getDeployment({ siteId: SITE_ID, deploymentId: deployment.$id })
  if (status === 'ready') {
    console.log('deployment ready')
    process.exit(0)
  }
  if (status === 'failed' || status === 'canceled') throw new Error(`deployment ${status}`)
  await new Promise((resolve) => setTimeout(resolve, 3000))
}
throw new Error('deployment did not finish in time')
