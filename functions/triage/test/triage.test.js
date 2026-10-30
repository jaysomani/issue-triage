import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cosine, createVectorStore, issueText } from '../src/triage.js'

test('issueText drops template boilerplate and keeps the report', () => {
  const body = [
    '<!-- Thanks for filing an issue -->',
    '### 👟 Reproduction steps',
    'Upload a 50 MB video',
    '- [x] I checked the docs',
    '### 👍 Expected behavior',
    'The upload succeeds',
  ].join('\n')

  const text = issueText('  Upload fails for big files ', body)

  assert.equal(text, 'Upload fails for big files\n\nUpload a 50 MB video The upload succeeds')
})

test('issueText keeps only the start of a long body', () => {
  const text = issueText('Title', 'word '.repeat(2000))

  assert.ok(text.length <= 'Title\n\n'.length + 1500)
})

test('cosine is 1 for the same direction and 0 for unrelated vectors', () => {
  assert.equal(cosine([1, 2, 3], [2, 4, 6]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
})

function fakeTablesDB(rows) {
  return {
    async listRows({ queries }) {
      const cursor = queries.find((query) => query.includes('cursorAfter'))
      return { rows: cursor ? [] : rows }
    },
    async upsertRow({ data }) {
      rows.push({ $id: String(data.number), ...data })
    },
  }
}

test('the TablesDB store ranks by similarity and skips the issue itself and later issues', async () => {
  const vectors = createVectorStore('tablesdb', {
    tablesDB: fakeTablesDB([
      { $id: '1', number: 1, embedding: [1, 0] },
      { $id: '2', number: 2, embedding: [0.9, 0.1] },
      { $id: '3', number: 3, embedding: [0, 1] },
      { $id: '5', number: 5, embedding: [1, 0] },
    ]),
  })

  const matches = await vectors.findSimilar([1, 0], { exclude: 1, before: 4, limit: 2 })

  assert.deepEqual(
    matches.map((match) => match.number),
    [2, 3],
  )
  assert.ok(matches[0].score > matches[1].score)
})

test('the TablesDB store finds a vector right after saving it', async () => {
  const vectors = createVectorStore('tablesdb', { tablesDB: fakeTablesDB([]) })

  await vectors.findSimilar([1, 0])
  await vectors.save(7, [0, 1])

  assert.deepEqual(await vectors.get(7), [0, 1])
})

test('a shared cache saves reloading vectors until it expires', async () => {
  const tablesDB = fakeTablesDB([{ $id: '1', number: 1, embedding: [1, 0] }])
  let loads = 0
  const countingTablesDB = {
    ...tablesDB,
    async listRows(params) {
      if (!params.queries.some((query) => query.includes('cursorAfter'))) loads++
      return tablesDB.listRows(params)
    },
  }
  const cache = { ttl: 60_000, vectors: null, loadedAt: 0 }

  await createVectorStore('tablesdb', { tablesDB: countingTablesDB }, { cache }).findSimilar([1, 0])
  await createVectorStore('tablesdb', { tablesDB: countingTablesDB }, { cache }).findSimilar([1, 0])
  assert.equal(loads, 1)

  cache.loadedAt = 0
  await createVectorStore('tablesdb', { tablesDB: countingTablesDB }, { cache }).findSimilar([1, 0])
  assert.equal(loads, 2)
})

test('an unknown vector store is rejected', () => {
  assert.throws(() => createVectorStore('redis', {}), /VECTOR_STORE must be vectorsdb or tablesdb/)
})
