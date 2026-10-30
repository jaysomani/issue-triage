import { Client, Embeddings, TablesDB, VectorsDB } from 'node-appwrite'
import { createVectorStore } from '../functions/triage/src/triage.js'

process.loadEnvFile(new URL('../.env', import.meta.url))

export const env = (key) => {
  const value = process.env[key]
  if (!value) throw new Error(`${key} is missing from .env`)
  return value
}

const client = new Client()
  .setEndpoint(env('APPWRITE_ENDPOINT'))
  .setProject(env('APPWRITE_PROJECT_ID'))
  .setKey(env('APPWRITE_API_KEY'))

export const vectorStore = process.env.VECTOR_STORE || 'vectorsdb'
export const tablesDB = new TablesDB(client)
export const vectorsDB = new VectorsDB(client)
export const embeddings = new Embeddings(client)
export const vectors = createVectorStore(vectorStore, { tablesDB, vectorsDB })
