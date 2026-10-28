// Finds the stored issues closest in meaning to some text. Usage: node search.mjs "upload fails for big files"
import { Query } from 'node-appwrite'
import { embeddings, tablesDB, vectorsDB } from './client.mjs'
import {
  DATABASE_ID,
  ISSUES_TABLE,
  embed,
  findSimilar,
} from '../functions/triage/src/triage.js'

const text = process.argv.slice(2).join(' ')
if (!text) throw new Error('Pass the text to search for')

const [vector] = await embed(embeddings, [text])
const matches = await findSimilar(vectorsDB, vector, { limit: 5 })

const { rows } = await tablesDB.listRows({
  databaseId: DATABASE_ID,
  tableId: ISSUES_TABLE,
  queries: [Query.equal('number', matches.map((match) => match.number))],
})
const issues = new Map(rows.map((row) => [row.number, row]))

for (const match of matches) {
  const issue = issues.get(match.number)
  const fix = issue?.fixedBy ? ` (fixed by #${issue.fixedBy})` : ''
  console.log(`${(match.score * 100).toFixed(0)}%  #${match.number} [${issue?.state}] ${issue?.title}${fix}`)
}
