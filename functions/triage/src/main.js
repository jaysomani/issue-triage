import crypto from 'node:crypto'
import { Client, Embeddings, Query, TablesDB, VectorsDB } from 'node-appwrite'
import {
  DATABASE_ID,
  ISSUES_TABLE,
  MATCHES_TABLE,
  embed,
  findSimilar,
  issueText,
  saveMatches,
  saveVector,
} from './triage.js'

const ISSUE_ACTIONS = new Set(['opened', 'edited', 'reopened', 'closed'])
const REVIEW_STATUSES = new Set(['confirmed', 'rejected', 'suggested'])

function services(req) {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(req.headers['x-appwrite-key'])
  return {
    tablesDB: new TablesDB(client),
    vectorsDB: new VectorsDB(client),
    embeddings: new Embeddings(client),
  }
}

function isSignedByGitHub(req) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET
  const signature = req.headers['x-hub-signature-256'] ?? ''
  if (!secret || !signature) return false
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(req.bodyText ?? '').digest('hex')}`
  return (
    expected.length === signature.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  )
}

async function withIssues(tablesDB, matches) {
  if (matches.length === 0) return []
  const { rows } = await tablesDB.listRows({
    databaseId: DATABASE_ID,
    tableId: ISSUES_TABLE,
    queries: [Query.equal('number', matches.map((match) => match.number))],
  })
  const issues = new Map(rows.map((row) => [row.number, row]))
  return matches.map((match) => ({ ...match, issue: issues.get(match.number) ?? null }))
}

async function handleWebhook(req, res, log) {
  if (!isSignedByGitHub(req)) {
    return res.json({ error: 'Invalid signature' }, 401)
  }
  const event = req.headers['x-github-event']
  const { action, issue } = req.bodyJson ?? {}
  if (event !== 'issues' || !ISSUE_ACTIONS.has(action) || issue?.pull_request) {
    return res.json({ ignored: true })
  }

  const { tablesDB, vectorsDB, embeddings } = services(req)
  const row = {
    number: issue.number,
    title: issue.title.slice(0, 512),
    body: issue.body ?? '',
    state: issue.state === 'open' ? 'open' : 'closed',
    url: issue.html_url,
    author: issue.user?.login ?? 'ghost',
    labels: (issue.labels ?? []).map((label) => label.name.slice(0, 128)),
    openedAt: issue.created_at,
  }

  // A closed issue keeps its suggestions; only its state changes
  if (action === 'closed') {
    await tablesDB.upsertRow({ databaseId: DATABASE_ID, tableId: ISSUES_TABLE, rowId: String(issue.number), data: row })
    return res.json({ number: issue.number, state: row.state })
  }

  const [vector] = await embed(embeddings, [issueText(issue.title, issue.body)])
  const matches = await findSimilar(vectorsDB, vector, { exclude: issue.number, limit: 3 })

  await tablesDB.upsertRow({ databaseId: DATABASE_ID, tableId: ISSUES_TABLE, rowId: String(issue.number), data: row })
  await saveVector(vectorsDB, issue.number, vector)
  await saveMatches(tablesDB, issue.number, matches)

  log(`#${issue.number} ${action}: best match ${matches[0] ? `#${matches[0].number} ${matches[0].score.toFixed(2)}` : 'none'}`)
  return res.json({ number: issue.number, matches })
}

async function handleCheck(req, res) {
  const { title = '', body = '' } = req.bodyJson ?? {}
  if (typeof title !== 'string' || typeof body !== 'string' || title.trim() === '') {
    return res.json({ error: 'A title is required' }, 400)
  }

  const { tablesDB, vectorsDB, embeddings } = services(req)
  const [vector] = await embed(embeddings, [issueText(title.slice(0, 512), body.slice(0, 10000))])
  const matches = await findSimilar(vectorsDB, vector, { limit: 5 })
  return res.json({ matches: await withIssues(tablesDB, matches) })
}

async function handleReview(req, res) {
  const { matchId, status } = req.bodyJson ?? {}
  if (typeof matchId !== 'string' || !REVIEW_STATUSES.has(status)) {
    return res.json({ error: 'matchId and a valid status are required' }, 400)
  }

  const { tablesDB } = services(req)
  const row = await tablesDB.updateRow({
    databaseId: DATABASE_ID,
    tableId: MATCHES_TABLE,
    rowId: matchId,
    data: { status },
  })
  return res.json({ matchId: row.$id, status: row.status })
}

export default async ({ req, res, log, error }) => {
  try {
    if (req.method !== 'POST') return res.json({ error: 'Method not allowed' }, 405)
    if (req.headers['x-github-event']) return await handleWebhook(req, res, log)
    if (req.path === '/check') return await handleCheck(req, res)
    if (req.path === '/review') return await handleReview(req, res)
    return res.json({ error: 'Not found' }, 404)
  } catch (err) {
    error(err.stack ?? String(err))
    return res.json({ error: 'Triage failed' }, 500)
  }
}
