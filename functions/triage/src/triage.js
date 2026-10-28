import { ID, Query } from 'node-appwrite'

export const DATABASE_ID = 'triage'
export const VECTORS_DATABASE_ID = 'triage-vectors'
export const ISSUES_TABLE = 'issues'
export const MATCHES_TABLE = 'matches'
export const VECTORS_COLLECTION = 'issues'
export const EMBEDDING_MODEL = 'nomic-embed-text'
export const EMBEDDING_DIMENSION = 768

// Measured on appwrite/appwrite: from about 0.90 pairs are the same report, and below
// 0.88 they mostly share an area but describe different bugs
export const MATCH_THRESHOLD = 0.88
const CANDIDATES = 12
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

/**
 * The closest stored issues to a vector, best first. VectorsDB orders by similarity but
 * doesn't return a score, so the score is computed from the returned vectors.
 */
export async function findSimilar(
  vectorsDB,
  vector,
  { exclude = null, before = Infinity, limit = 5 } = {},
) {
  const result = await vectorsDB.listDocuments({
    databaseId: VECTORS_DATABASE_ID,
    collectionId: VECTORS_COLLECTION,
    queries: [Query.vectorCosine('embeddings', vector), Query.limit(CANDIDATES)],
  })

  return result.documents
    .map((document) => ({
      number: Number(document.$id),
      score: cosine(vector, document.embeddings),
    }))
    .filter((match) => match.number !== exclude && match.number < before)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export async function saveVector(vectorsDB, number, vector) {
  await vectorsDB.upsertDocument({
    databaseId: VECTORS_DATABASE_ID,
    collectionId: VECTORS_COLLECTION,
    documentId: String(number),
    data: { embeddings: vector, metadata: { number } },
  })
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
