// Imports recent issues of a GitHub repository, with the pull request that closed each one,
// and stores them with their embeddings. Usage: node import.mjs [count]
import { embeddings, env, tablesDB, vectorsDB } from './client.mjs'
import {
  DATABASE_ID,
  ISSUES_TABLE,
  embed,
  issueText,
  saveVector,
} from '../functions/triage/src/triage.js'

const COUNT = Number(process.argv[2] ?? 600)
const PAGE_SIZE = 50
// Small batches keep each embeddings request under the embedding service's timeout
const EMBED_BATCH = 4

const [owner, name] = env('GITHUB_REPO').split('/')

const QUERY = `
  query ($owner: String!, $name: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(first: $first, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number title body state url createdAt
          author { login }
          labels(first: 10) { nodes { name } }
          closedByPullRequestsReferences(first: 1, includeClosedPrs: false) {
            nodes { number url merged }
          }
        }
      }
    }
  }`

async function fetchIssues() {
  const issues = []
  let after = null

  while (issues.length < COUNT) {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env('GITHUB_TOKEN')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: QUERY,
        variables: { owner, name, first: Math.min(PAGE_SIZE, COUNT - issues.length), after },
      }),
    })
    const { data, errors } = await response.json()
    if (errors) throw new Error(errors.map((error) => error.message).join('; '))

    const page = data.repository.issues
    issues.push(...page.nodes)
    console.log(`fetched ${issues.length} issues`)
    if (!page.pageInfo.hasNextPage) break
    after = page.pageInfo.endCursor
  }

  return issues
}

function toRow(issue) {
  const fix = issue.closedByPullRequestsReferences.nodes.find((pr) => pr.merged)
  return {
    number: issue.number,
    title: issue.title.slice(0, 512),
    body: issue.body ?? '',
    state: issue.state === 'OPEN' ? 'open' : 'closed',
    url: issue.url,
    author: issue.author?.login ?? 'ghost',
    labels: issue.labels.nodes.map((label) => label.name.slice(0, 128)),
    openedAt: issue.createdAt,
    fixedBy: fix?.number ?? null,
    fixedByUrl: fix?.url ?? null,
  }
}

const issues = await fetchIssues()

for (let i = 0; i < issues.length; i += EMBED_BATCH) {
  const batch = issues.slice(i, i + EMBED_BATCH)
  const vectors = await embed(
    embeddings,
    batch.map((issue) => issueText(issue.title, issue.body)),
  )

  for (const [index, issue] of batch.entries()) {
    await tablesDB.upsertRow({
      databaseId: DATABASE_ID,
      tableId: ISSUES_TABLE,
      rowId: String(issue.number),
      data: toRow(issue),
    })
    await saveVector(vectorsDB, issue.number, vectors[index])
  }
  console.log(`stored ${Math.min(i + EMBED_BATCH, issues.length)} / ${issues.length}`)
}

console.log('import done')
