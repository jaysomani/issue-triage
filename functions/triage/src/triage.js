import { ID, Query } from 'node-appwrite'

export const DATABASE_ID = 'triage'
export const VECTORS_DATABASE_ID = 'triage-vectors'
export const ISSUES_TABLE = 'issues'
export const MATCHES_TABLE = 'matches'
export const VECTORS_COLLECTION = 'issues'
export const VECTORS_TABLE = 'vectors'
export const EMBEDDING_MODEL = 'nomic-embed-text'
export const EMBEDDING_DIMENSION = 768

// Measured on appwrite/appwrite: from about 0.90 pairs are the same report, and below
// 0.88 they mostly share an area but describe different bugs
export const MATCH_THRESHOLD = 0.88
const CANDIDATES = 12
const VECTOR_PAGE = 200
const BODY_CHARS = 1500

/**
 * The text that represents an issue for similarity: its title plus the start of its body,
 * without the issue template boilerplate that every report shares.
 */
export function issueText(title, body) {
  const cleaned = (body ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^#{1,6}\s.*$/gm, ' ')
    .replace(/^\s*-\s*\[[ xX]\]\s.*$/gm, ' ')
    .replace(/```[\s\S]*?```/g, (block) => block.slice(0, 400))
    .replace(/\s+/g, ' ')
    .trim()

  return `${title.trim()}\n\n${cleaned.slice(0, BODY_CHARS)}`
}

export function cosine(a, b) {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

const isVector = (item) => item?.embedding?.length === EMBEDDING_DIMENSION

export async function embed(embeddings, texts) {
  const result = await embeddings.createTextEmbeddings({
    texts,
    model: EMBEDDING_MODEL,
  })

  // A slow batch can fail as a whole, so failed texts get one more try on their own
  const vectors = []
  for (const [index, item] of result.embeddings.entries()) {
    if (isVector(item)) {
      vectors.push(item.embedding)
      continue
    }
    const retry = await embeddings.createTextEmbeddings({
      texts: [texts[index]],
      model: EMBEDDING_MODEL,
    })
    if (!isVector(retry.embeddings[0])) {
      throw new Error(`Embedding failed: ${retry.embeddings[0]?.error ?? 'no vector returned'}`)
    }
    vectors.push(retry.embeddings[0].embedding)
  }
  return vectors
}

const rank = (vector, candidates, { exclude = null, before = Infinity, limit = 5 } = {}) =>
  candidates
    .map((candidate) => ({ number: candidate.number, score: cosine(vector, candidate.vector) }))
    .filter((match) => match.number !== exclude && match.number < before)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

/**
 * Vectors in VectorsDB, which finds the nearest ones itself. It orders by similarity but
 * doesn't return a score, so the score is computed from the returned vectors.
 */
function vectorsDBStore(vectorsDB) {
  const target = { databaseId: VECTORS_DATABASE_ID, collectionId: VECTORS_COLLECTION }
  return {
    async save(number, vector) {
      await vectorsDB.upsertDocument({
        ...target,
        documentId: String(number),
        data: { embeddings: vector, metadata: { number } },
      })
    },
    async get(number) {
      const document = await vectorsDB.getDocument({ ...target, documentId: String(number) })
      return document.embeddings
    },
    async remove(number) {
      await vectorsDB.deleteDocument({ ...target, documentId: String(number) })
    },
    async findSimilar(vector, options) {
      const { documents } = await vectorsDB.listDocuments({
        ...target,
        queries: [Query.vectorCosine('embeddings', vector), Query.limit(CANDIDATES)],
      })
      return rank(
        vector,
        documents.map((document) => ({ number: Number(document.$id), vector: document.embeddings })),
        options,
      )
    },
  }
}

/**
 * Vectors in a TablesDB table, compared in code. For where VectorsDB isn't available, such as
 * Appwrite Cloud's free plan; a repository's issues are few enough to compare them all.
 * All vectors are loaded once per store, so a batch of searches downloads them only once.
 * A shared cache keeps them across stores for `cache.ttl` milliseconds, such as between the
 * executions of a warm function.
 */
function tablesDBStore(tablesDB, cache = null) {
  const target = { databaseId: DATABASE_ID, tableId: VECTORS_TABLE }
  let loaded = null

  async function all() {
    if (loaded) return loaded
    if (cache?.vectors && Date.now() - cache.loadedAt < cache.ttl) {
      loaded = cache.vectors
      return loaded
    }
    loaded = new Map()
    let cursor = null
    do {
      const { rows } = await tablesDB.listRows({
        ...target,
        queries: [
          Query.select(['$id', 'number', 'embedding']),
          Query.limit(VECTOR_PAGE),
          ...(cursor ? [Query.cursorAfter(cursor)] : []),
        ],
      })
      for (const row of rows) loaded.set(row.number, row.embedding)
      cursor = rows.length === VECTOR_PAGE ? rows.at(-1).$id : null
    } while (cursor)
    if (cache) {
      cache.vectors = loaded
      cache.loadedAt = Date.now()
    }
    return loaded
  }

  return {
    async save(number, vector) {
      await tablesDB.upsertRow({ ...target, rowId: String(number), data: { number, embedding: vector } })
      loaded?.set(number, vector)
    },
    async get(number) {
      const vectors = await all()
      if (!vectors.has(number)) throw new Error(`No vector stored for #${number}`)
      return vectors.get(number)
    },
    async remove(number) {
      await tablesDB.deleteRow({ ...target, rowId: String(number) })
      loaded?.delete(number)
    },
    async findSimilar(vector, options) {
      const vectors = await all()
      return rank(
        vector,
        [...vectors].map(([number, candidate]) => ({ number, vector: candidate })),
        options,
      )
    },
  }
}

export function createVectorStore(kind, { tablesDB, vectorsDB }, { cache = null } = {}) {
  if (kind === 'tablesdb') return tablesDBStore(tablesDB, cache)
  if (kind === 'vectorsdb') return vectorsDBStore(vectorsDB)
  throw new Error(`VECTOR_STORE must be vectorsdb or tablesdb, got "${kind}"`)
}

/**
 * Store the likely duplicates of an issue, replacing earlier suggestions but keeping reviewed ones.
 */
export async function saveMatches(tablesDB, number, matches) {
  const existing = await tablesDB.listRows({
    databaseId: DATABASE_ID,
    tableId: MATCHES_TABLE,
    queries: [Query.equal('issue', number), Query.limit(100)],
  })
  const reviewed = new Set(
    existing.rows
      .filter((row) => row.status !== 'suggested')
      .map((row) => row.match),
  )

  for (const row of existing.rows) {
    if (row.status === 'suggested') {
      await tablesDB.deleteRow({
        databaseId: DATABASE_ID,
        tableId: MATCHES_TABLE,
        rowId: row.$id,
      })
    }
  }

  for (const match of matches) {
    if (match.score < MATCH_THRESHOLD || reviewed.has(match.number)) continue
    await tablesDB.createRow({
      databaseId: DATABASE_ID,
      tableId: MATCHES_TABLE,
      rowId: ID.unique(),
      data: {
        issue: number,
        match: match.number,
        score: Math.round(match.score * 1000) / 1000,
        status: 'suggested',
      },
    })
  }
}
