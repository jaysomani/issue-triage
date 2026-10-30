// Removes the fake issues used by tests (numbers 999990 and up), with their vectors and matches.
import { AppwriteException, Query } from 'node-appwrite'
import { tablesDB, vectors } from './client.mjs'
import {
  DATABASE_ID,
  ISSUES_TABLE,
  MATCHES_TABLE,
} from '../functions/triage/src/triage.js'

const FIRST_TEST_NUMBER = 999990
const ignoreMissing = (error) => {
  if (!(error instanceof AppwriteException && error.code === 404)) throw error
}

const { rows: matches } = await tablesDB.listRows({
  databaseId: DATABASE_ID,
  tableId: MATCHES_TABLE,
  queries: [
    Query.or([
      Query.greaterThanEqual('issue', FIRST_TEST_NUMBER),
      Query.greaterThanEqual('match', FIRST_TEST_NUMBER),
    ]),
    Query.limit(100),
  ],
})
for (const row of matches) {
  await tablesDB.deleteRow({ databaseId: DATABASE_ID, tableId: MATCHES_TABLE, rowId: row.$id })
}

const { rows: issues } = await tablesDB.listRows({
  databaseId: DATABASE_ID,
  tableId: ISSUES_TABLE,
  queries: [Query.greaterThanEqual('number', FIRST_TEST_NUMBER), Query.limit(100)],
})
for (const row of issues) {
  await tablesDB.deleteRow({ databaseId: DATABASE_ID, tableId: ISSUES_TABLE, rowId: row.$id })
  await vectors.remove(row.number).catch(ignoreMissing)
}

console.log(`removed ${issues.length} test issues and ${matches.length} matches`)
