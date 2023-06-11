// A small GitHub API client on fetch: REST and GraphQL, with retries on
// transient failures. GITHUB_API_URL and GITHUB_GRAPHQL_URL point it at GHES
// or at a fake server in tests.

export class APIError extends Error {
  constructor(message, status, body) {
    super(message)
    this.status = status
    this.body = body
  }
}

const TRANSIENT = new Set([500, 502, 503, 504])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// path encodes every segment of a slash-separated name, never the slashes.
export const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/')

export function client(token, { env = process.env, wait = sleep } = {}) {
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '')
  const graphqlURL = env.GITHUB_GRAPHQL_URL || `${api}/graphql`
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'octomation-vanity-action',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }

  // send retries reads only: a write whose response is lost may have
  // happened, and the publication's own checks decide what to do next
  const send = async (url, init) => {
    const retry = init.method === 'GET'
    for (let attempt = 1; ; attempt++) {
      let res
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) })
      } catch (err) {
        if (!retry || attempt >= 3) throw new APIError(`${init.method} ${url}: ${err.message}`, 0)
        await wait(1000 * attempt)
        continue
      }
      if (retry && TRANSIENT.has(res.status) && attempt < 3) {
        await wait(1000 * attempt)
        continue
      }
      return res
    }
  }

  // rest returns the parsed body, null for a 404 on GET, and throws an
  // APIError with the status otherwise.
  const rest = async (method, path, body) => {
    const res = await send(`${api}${path}`, {
      method,
      headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: body ? JSON.stringify(body) : undefined,
    })
    if (res.status === 404 && method === 'GET') return null
    const text = await res.text()
    if (!res.ok) throw new APIError(`${method} ${path}: ${res.status} ${text.slice(0, 500)}`, res.status, text)
    return text ? JSON.parse(text) : null
  }

  const graphql = async (query, variables) => {
    const res = await send(graphqlURL, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new APIError(`graphql: ${res.status} ${text.slice(0, 500)}`, res.status, text)
    }
    if (!res.ok || json.errors) {
      const err = new APIError(`graphql: ${res.status} ${JSON.stringify(json.errors || json).slice(0, 1000)}`, res.status, text)
      err.graphql = json.errors || []
      throw err
    }
    return json.data
  }

  return { rest, graphql }
}

// repositoryMetadata reads what an entry takes from the repository itself.
export async function repositoryMetadata(rest, repository) {
  const repo = await rest('GET', `/repos/${encodePath(repository)}`)
  if (!repo) throw new APIError(`${repository}: repository not found or not readable with the token`, 404)
  return {
    repository: repo.full_name || repository,
    branch: repo.default_branch,
    visibility: repo.visibility || (repo.private ? 'private' : 'public'),
    topics: repo.topics || [],
    // owner/name of the template the repository was generated from, or null
    template: repo.template_repository?.full_name || null,
  }
}
