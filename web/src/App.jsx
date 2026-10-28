import { useCallback, useEffect, useRef, useState } from 'react'
import {
  REPO,
  checkIssue,
  countIssues,
  countMatches,
  getIssues,
  listMatches,
  reviewMatch,
  subscribeToTriage,
} from './appwrite.js'

const TABS = [
  { status: 'suggested', label: 'To review' },
  { status: 'confirmed', label: 'Confirmed duplicates' },
  { status: 'rejected', label: 'Not related' },
]

// From this score, pairs on appwrite/appwrite were almost always the same report
const VERY_LIKELY = 0.92

const percent = (score) => `${Math.round(score * 100)}%`

function timeAgo(date) {
  const seconds = Math.round((Date.now() - new Date(date).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ]
  for (const [unit, size] of units) {
    const value = Math.floor(seconds / size)
    if (value >= 1) return `${value} ${unit}${value > 1 ? 's' : ''} ago`
  }
  return 'just now'
}

function Stats({ stats }) {
  return (
    <div className="stats">
      <div className="stat">
        <span className="stat-value">{stats.issues ?? '…'}</span>
        <span className="stat-label">issues indexed</span>
      </div>
      <div className="stat">
        <span className="stat-value">{stats.suggested ?? '…'}</span>
        <span className="stat-label">likely duplicates to review</span>
      </div>
      <div className="stat">
        <span className="stat-value">{stats.confirmed ?? '…'}</span>
        <span className="stat-label">confirmed duplicates</span>
      </div>
    </div>
  )
}

function IssueSummary({ issue, number, label }) {
  if (!issue) {
    return (
      <div className="issue">
        <span className="issue-label">{label}</span>
        <span className="issue-title">#{number}</span>
      </div>
    )
  }
  return (
    <div className="issue">
      <span className="issue-label">{label}</span>
      <a className="issue-title" href={issue.url} target="_blank" rel="noreferrer">
        <span className="issue-number">#{issue.number}</span> {issue.title}
      </a>
      <div className="issue-meta">
        <span className={`state state-${issue.state}`}>{issue.state}</span>
        <span>by {issue.author}</span>
        <span>{timeAgo(issue.openedAt)}</span>
        {issue.fixedBy && (
          <a href={issue.fixedByUrl} target="_blank" rel="noreferrer" className="fix">
            fixed in #{issue.fixedBy}
          </a>
        )}
      </div>
    </div>
  )
}

function MatchCard({ match, issues, fresh, onReview, busy }) {
  return (
    <article className={`match ${fresh ? 'match-fresh' : ''}`}>
      <IssueSummary issue={issues.get(match.issue)} number={match.issue} label="New report" />
      <div className="match-score">
        <span className="score">{percent(match.score)}</span>
        <span className="score-label">
          {match.score >= VERY_LIKELY ? 'very likely' : 'possible'}
        </span>
      </div>
      <IssueSummary issue={issues.get(match.match)} number={match.match} label="Looks like" />
      <div className="match-actions">
        {match.status !== 'confirmed' && (
          <button className="primary" disabled={busy} onClick={() => onReview(match, 'confirmed')}>
            Duplicate
          </button>
        )}
        {match.status !== 'rejected' && (
          <button disabled={busy} onClick={() => onReview(match, 'rejected')}>
            Not related
          </button>
        )}
        {match.status !== 'suggested' && (
          <button className="link" disabled={busy} onClick={() => onReview(match, 'suggested')}>
            Undo
          </button>
        )}
      </div>
    </article>
  )
}

function CheckIssue() {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [results, setResults] = useState(null)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)

  const submit = async (event) => {
    event.preventDefault()
    setChecking(true)
    setError('')
    try {
      const { matches } = await checkIssue(title, body)
      setResults(matches)
    } catch (err) {
      setError(err.message)
      setResults(null)
    } finally {
      setChecking(false)
    }
  }

  return (
    <section className="panel">
      <h2>Check an issue before it's filed</h2>
      <p className="muted">Paste a bug report to see whether it has been reported already.</p>
      <form onSubmit={submit} className="check-form">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Title, e.g. Large file uploads fail with a 500 error"
          required
        />
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Description (optional)"
          rows={4}
        />
        <button className="primary" disabled={checking || title.trim() === ''}>
          {checking ? 'Checking…' : 'Find similar issues'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {results && (
        <ul className="results">
          {results.length === 0 && <li className="muted">No similar issues found.</li>}
          {results.map(({ number, score, issue }) => (
            <li key={number}>
              <span className="score small">{percent(score)}</span>
              <a href={issue?.url} target="_blank" rel="noreferrer">
                #{number} {issue?.title}
              </a>
              {issue && <span className={`state state-${issue.state}`}>{issue.state}</span>}
              {issue?.fixedBy && <span className="fix">fixed in #{issue.fixedBy}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default function App() {
  const [tab, setTab] = useState('suggested')
  const [matches, setMatches] = useState([])
  const [issues, setIssues] = useState(new Map())
  const [stats, setStats] = useState({})
  const [fresh, setFresh] = useState(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [activity, setActivity] = useState(null)

  const latestLoad = useRef(0)

  const load = useCallback(async () => {
    // Realtime events can start several loads at once; only the newest may update the page
    const current = ++latestLoad.current
    try {
      const [rows, total, suggested, confirmed] = await Promise.all([
        listMatches(tab),
        countIssues(),
        countMatches('suggested'),
        countMatches('confirmed'),
      ])
      const issueRows = await getIssues(rows.flatMap((row) => [row.issue, row.match]))
      if (current !== latestLoad.current) return
      setMatches(rows)
      setIssues(issueRows)
      setStats({ issues: total, suggested, confirmed })
      setError('')
    } catch (err) {
      if (current === latestLoad.current) setError(err.message)
    } finally {
      if (current === latestLoad.current) setLoading(false)
    }
  }, [tab])

  useEffect(() => {
    setLoading(true)
    load()
  }, [load])

  // New issues and suggestions arrive while the page is open, so it refreshes and highlights them
  useEffect(() => {
    const pending = subscribeToTriage((event) => {
      const row = event.payload
      const created = event.events.some((name) => name.endsWith('.create'))
      // Every checked issue shows up here, including the ones without a duplicate
      if (row?.title && row?.number) {
        setActivity({ number: row.number, title: row.title, url: row.url, duplicates: 0 })
      }
      if (created && row?.issue) {
        setActivity((current) =>
          current?.number === row.issue
            ? { ...current, duplicates: current.duplicates + 1 }
            : current,
        )
        setFresh((current) => new Set(current).add(row.$id))
        setTimeout(() => {
          setFresh((current) => {
            const next = new Set(current)
            next.delete(row.$id)
            return next
          })
        }, 6000)
      }
      load()
    })
    return () => {
      pending.then((subscription) => subscription.unsubscribe())
    }
  }, [load])

  const review = async (match, status) => {
    setBusy(true)
    try {
      await reviewMatch(match.$id, status)
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>Triage</h1>
          <p className="muted">
            Duplicate reports in <a href={`https://github.com/${REPO}/issues`} target="_blank" rel="noreferrer">{REPO}</a>, found by meaning, updated live.
          </p>
        </div>
        <span className="live">● Live</span>
      </header>

      {activity && (
        <p className="activity">
          <span className="activity-dot" /> Just checked{' '}
          <a href={activity.url} target="_blank" rel="noreferrer">
            #{activity.number} {activity.title}
          </a>{' '}
          ·{' '}
          {activity.duplicates === 0
            ? 'no duplicates found'
            : `${activity.duplicates} likely duplicate${activity.duplicates > 1 ? 's' : ''}`}
        </p>
      )}

      <Stats stats={stats} />

      <div className="layout">
        <main>
          <nav className="tabs">
            {TABS.map((item) => (
              <button
                key={item.status}
                className={tab === item.status ? 'tab tab-active' : 'tab'}
                onClick={() => setTab(item.status)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          {error && <p className="error">{error}</p>}
          {loading ? (
            <p className="muted">Loading…</p>
          ) : matches.length === 0 ? (
            <p className="muted empty">Nothing here yet.</p>
          ) : (
            matches.map((match) => (
              <MatchCard
                key={match.$id}
                match={match}
                issues={issues}
                fresh={fresh.has(match.$id)}
                onReview={review}
                busy={busy}
              />
            ))
          )}
        </main>
        <aside>
          <CheckIssue />
          <section className="panel">
            <h2>How it works</h2>
            <ol className="muted how">
              <li>Every new GitHub issue reaches an Appwrite Function through a webhook.</li>
              <li>Appwrite Embeddings turns its text into a vector.</li>
              <li>VectorsDB finds the closest earlier issues by meaning.</li>
              <li>Likely duplicates are stored in TablesDB and appear here through Realtime.</li>
            </ol>
          </section>
        </aside>
      </div>
    </div>
  )
}
