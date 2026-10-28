import {
  Channel,
  Client,
  ExecutionMethod,
  Functions,
  Query,
  Realtime,
  TablesDB,
} from 'appwrite'

export const DATABASE_ID = 'triage'
export const ISSUES_TABLE = 'issues'
export const MATCHES_TABLE = 'matches'
export const REPO = import.meta.env.VITE_GITHUB_REPO ?? 'appwrite/appwrite'

const client = new Client()
  .setEndpoint(import.meta.env.VITE_APPWRITE_ENDPOINT)
  .setProject(import.meta.env.VITE_APPWRITE_PROJECT_ID)

const tablesDB = new TablesDB(client)
const functions = new Functions(client)
const realtime = new Realtime(client)

export async function listMatches(status) {
  const { rows } = await tablesDB.listRows({
    databaseId: DATABASE_ID,
    tableId: MATCHES_TABLE,
    queries: [Query.equal('status', status), Query.orderDesc('$createdAt'), Query.limit(50)],
  })
  return rows
}

export async function countMatches(status) {
  const { total } = await tablesDB.listRows({
    databaseId: DATABASE_ID,
    tableId: MATCHES_TABLE,
    queries: [Query.equal('status', status), Query.limit(1)],
  })
  return total
}

export async function countIssues() {
  const { total } = await tablesDB.listRows({
    databaseId: DATABASE_ID,
    tableId: ISSUES_TABLE,
    queries: [Query.limit(1)],
  })
  return total
}

export async function getIssues(numbers) {
  const unique = [...new Set(numbers)]
  if (unique.length === 0) return new Map()
  const { rows } = await tablesDB.listRows({
    databaseId: DATABASE_ID,
    tableId: ISSUES_TABLE,
    queries: [Query.equal('number', unique), Query.limit(unique.length)],
  })
  return new Map(rows.map((row) => [row.number, row]))
}

async function runTriage(path, body) {
  const execution = await functions.createExecution({
    functionId: 'triage',
    body: JSON.stringify(body),
    xpath: path,
    method: ExecutionMethod.POST,
    headers: { 'content-type': 'application/json' },
  })
  const result = JSON.parse(execution.responseBody || '{}')
  if (execution.responseStatusCode >= 400) {
    throw new Error(result.error ?? 'Triage failed')
  }
  return result
}

export const checkIssue = (title, body) => runTriage('/check', { title, body })
export const reviewMatch = (matchId, status) => runTriage('/review', { matchId, status })

export function subscribeToTriage(onChange) {
  return realtime.subscribe(
    [
      Channel.tablesdb(DATABASE_ID).table(MATCHES_TABLE).row(),
      Channel.tablesdb(DATABASE_ID).table(ISSUES_TABLE).row(),
    ],
    onChange,
  )
}
