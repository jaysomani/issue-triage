// Finds likely duplicates among the imported issues: each issue is compared with the
// issues reported before it. Usage: node analyze.mjs
import { Query } from 'node-appwrite'
import { tablesDB, vectorsDB } from './client.mjs'
import {
  DATABASE_ID,
  ISSUES_TABLE,
  MATCH_THRESHOLD,
  VECTORS_COLLECTION,
  VECTORS_DATABASE_ID,
  findSimilar,
  saveMatches,
} from '../functions/triage/src/triage.js'

const numbers = []
let cursor = null
do {
  const page = await tablesDB.listRows({
    databaseId: DATABASE_ID,
    tableId: ISSUES_TABLE,
    queries: [
      Query.select(['number']),
      Query.orderAsc('number'),
      Query.limit(100),
      ...(cursor ? [Query.cursorAfter(cursor)] : []),
    ],
  })
  numbers.push(...page.rows.map((row) => row.number))
  cursor = page.rows.length === 100 ? page.rows.at(-1).$id : null
} while (cursor)

let found = 0
for (const [index, number] of numbers.entries()) {
  const { embeddings: vector } = await vectorsDB.getDocument({
    databaseId: VECTORS_DATABASE_ID,
    collectionId: VECTORS_COLLECTION,
    documentId: String(number),
  })
  const matches = await findSimilar(vectorsDB, vector, { exclude: number, before: number, limit: 3 })
  await saveMatches(tablesDB, number, matches)
  found += matches.filter((match) => match.score >= MATCH_THRESHOLD).length

  if ((index + 1) % 50 === 0) console.log(`analyzed ${index + 1} / ${numbers.length}`)
}

console.log(`analyze done: ${found} likely duplicates across ${numbers.length} issues`)
