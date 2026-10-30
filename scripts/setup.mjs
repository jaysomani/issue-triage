// Creates the databases, tables and vector collection. Safe to run again.
import { AppwriteException, Permission, Role, TablesDBIndexType } from 'node-appwrite'
import { tablesDB, vectorStore, vectorsDB } from './client.mjs'
import {
  DATABASE_ID,
  EMBEDDING_DIMENSION,
  ISSUES_TABLE,
  MATCHES_TABLE,
  VECTORS_COLLECTION,
  VECTORS_DATABASE_ID,
  VECTORS_TABLE,
} from '../functions/triage/src/triage.js'

// The dashboard is a public demo, so anyone may read; only the function and scripts write
const READ_ANY = [Permission.read(Role.any())]

async function ignoreExisting(label, create) {
  try {
    await create()
    console.log(`created ${label}`)
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 409) {
      console.log(`exists  ${label}`)
      return
    }
    throw error
  }
}

const table = { databaseId: DATABASE_ID }

// Appwrite Cloud checks the plan limit before whether a database exists, so look first
async function createDatabaseIfMissing(label, service, databaseId, name) {
  try {
    await service.get({ databaseId })
    console.log(`exists  ${label}`)
  } catch (error) {
    if (!(error instanceof AppwriteException && error.code === 404)) throw error
    await service.create({ databaseId, name })
    console.log(`created ${label}`)
  }
}

await createDatabaseIfMissing('database triage', tablesDB, DATABASE_ID, 'Triage')

await ignoreExisting('table issues', () =>
  tablesDB.createTable({ ...table, tableId: ISSUES_TABLE, name: 'Issues', permissions: READ_ANY }),
)
const issue = { ...table, tableId: ISSUES_TABLE }
await ignoreExisting('issues.number', () => tablesDB.createIntegerColumn({ ...issue, key: 'number', required: true }))
await ignoreExisting('issues.title', () => tablesDB.createVarcharColumn({ ...issue, key: 'title', size: 512, required: true }))
await ignoreExisting('issues.body', () => tablesDB.createTextColumn({ ...issue, key: 'body', required: false }))
await ignoreExisting('issues.state', () => tablesDB.createEnumColumn({ ...issue, key: 'state', elements: ['open', 'closed'], required: true }))
await ignoreExisting('issues.url', () => tablesDB.createVarcharColumn({ ...issue, key: 'url', size: 512, required: true }))
await ignoreExisting('issues.author', () => tablesDB.createVarcharColumn({ ...issue, key: 'author', size: 128, required: false }))
await ignoreExisting('issues.labels', () => tablesDB.createVarcharColumn({ ...issue, key: 'labels', size: 128, required: false, array: true }))
await ignoreExisting('issues.openedAt', () => tablesDB.createDatetimeColumn({ ...issue, key: 'openedAt', required: true }))
await ignoreExisting('issues.fixedBy', () => tablesDB.createIntegerColumn({ ...issue, key: 'fixedBy', required: false }))
await ignoreExisting('issues.fixedByUrl', () => tablesDB.createVarcharColumn({ ...issue, key: 'fixedByUrl', size: 512, required: false }))

await ignoreExisting('table matches', () =>
  tablesDB.createTable({ ...table, tableId: MATCHES_TABLE, name: 'Matches', permissions: READ_ANY }),
)
const match = { ...table, tableId: MATCHES_TABLE }
await ignoreExisting('matches.issue', () => tablesDB.createIntegerColumn({ ...match, key: 'issue', required: true }))
await ignoreExisting('matches.match', () => tablesDB.createIntegerColumn({ ...match, key: 'match', required: true }))
await ignoreExisting('matches.score', () => tablesDB.createFloatColumn({ ...match, key: 'score', required: true }))
await ignoreExisting('matches.status', () => tablesDB.createEnumColumn({ ...match, key: 'status', elements: ['suggested', 'confirmed', 'rejected'], required: true }))

// Columns are created in the background, and indexes need them ready
async function waitForColumns(tableId) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const { columns } = await tablesDB.listColumns({ ...table, tableId })
    if (columns.every((column) => column.status === 'available')) return
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`columns of ${tableId} did not become available`)
}
await waitForColumns(ISSUES_TABLE)
await waitForColumns(MATCHES_TABLE)

await ignoreExisting('index issues.number', () =>
  tablesDB.createIndex({ ...issue, key: 'number', type: TablesDBIndexType.Unique, columns: ['number'] }),
)
await ignoreExisting('index issues.openedAt', () =>
  tablesDB.createIndex({ ...issue, key: 'openedAt', type: TablesDBIndexType.Key, columns: ['openedAt'] }),
)
await ignoreExisting('index matches.issue', () =>
  tablesDB.createIndex({ ...match, key: 'issue', type: TablesDBIndexType.Key, columns: ['issue'] }),
)
await ignoreExisting('index matches.status', () =>
  tablesDB.createIndex({ ...match, key: 'status', type: TablesDBIndexType.Key, columns: ['status'] }),
)

if (vectorStore === 'vectorsdb') {
  await createDatabaseIfMissing('vectors database', vectorsDB, VECTORS_DATABASE_ID, 'Triage vectors')
  await ignoreExisting('vector collection issues', () =>
    vectorsDB.createCollection({
      databaseId: VECTORS_DATABASE_ID,
      collectionId: VECTORS_COLLECTION,
      name: 'Issue vectors',
      dimension: EMBEDDING_DIMENSION,
    }),
  )
} else {
  // Only the function and scripts read vectors, so the table has no permissions
  await ignoreExisting('table vectors', () =>
    tablesDB.createTable({ ...table, tableId: VECTORS_TABLE, name: 'Vectors' }),
  )
  const vector = { ...table, tableId: VECTORS_TABLE }
  await ignoreExisting('vectors.number', () => tablesDB.createIntegerColumn({ ...vector, key: 'number', required: true }))
  await ignoreExisting('vectors.embedding', () =>
    tablesDB.createFloatColumn({ ...vector, key: 'embedding', required: false, array: true }),
  )
  await waitForColumns(VECTORS_TABLE)
}

console.log(`setup done (vectors in ${vectorStore})`)
