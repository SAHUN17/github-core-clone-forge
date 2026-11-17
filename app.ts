// GitHub-compatible forge: the REST v3 surface of the contest's one process.
//
// app.ts is the server and nothing else: main.ts keeps the entry <-> env lifecycle (bind an
// ephemeral port, register it with the env, poll /done, exit 0) and hands every request here.
// Everything this file serves comes from its own store (lib/store.ts) and its own git object
// model (lib/git.ts): no git binary, no outside service, no package at run time.
//
// The routes are GitHub's, under /api/v3:
//   GET    /                            the API root and the token's scopes
//   GET    /meta                        the installed version
//   POST   /user/repos                  create a repository
//   GET    /user/repos?per_page=&page=  the token's repositories, paged through Link rel="next"
//   GET    /repos/{o}/{r}               one repository; PATCH its description; DELETE it
//   POST   /repos/{o}/{r}/git/refs      create a branch at a commit
//   GET    /repos/{o}/{r}/branches      the branches and their tips
//   GET    /repos/{o}/{r}/commits       the commits reachable from a branch
//   PUT    /repos/{o}/{r}/contents/{p}  create or update a file with a commit
//   GET    /repos/{o}/{r}/contents/{p}  a file's bytes, or a directory's entries
//   DELETE /repos/{o}/{r}/contents/{p}  remove a file with a commit
//   POST   /repos/{o}/{r}/labels        create a label
//   POST   /repos/{o}/{r}/issues        open an issue (422 on an unknown label)
//   GET    /repos/{o}/{r}/issues        list, filtered by state and sorted by creation
//   GET    /repos/{o}/{r}/issues/{n}    one issue; PATCH {state} closes or reopens it
//   POST   /repos/{o}/{r}/issues/{n}/comments   comment on an issue; GET lists them
//   POST   /repos/{o}/{r}/pulls         open a pull request from a head branch
//   GET    /repos/{o}/{r}/pulls         list by state (open by default)
//   GET    /repos/{o}/{r}/pulls/{n}     one pull request; 404 when unknown
//   GET    /repos/{o}/{r}/pulls/{n}/files       the paths the head branch changed
//   PUT    /repos/{o}/{r}/pulls/{n}/merge       squash-merge it onto its base branch
//
// Two properties the checks lean on: every reply is JSON (never HTML) and carries a non-empty
// X-GitHub-Request-Id, and no reply depends on the wall clock. Every timestamp is the store's
// fixed EPOCH_ISO, every id is a counter, so a replay of the same requests reaches the same bytes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { store, EPOCH_ISO, type Issue, type Pull, type Repo } from './lib/store.ts';
import {
  getObject,
  parseCommit,
  parseTree,
  flattenTree,
  writeFlatTree,
  putObject,
  writeCommit,
} from './lib/git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The bearer token the env presents on every API call (wire.ts TOKEN_ENV). */
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** A login no seeded user carries: the placeholder a repository is created under before the
 *  first owner-carrying request names the token's login. */
const PENDING_OWNER = '\u0000pending';

/** The author line every commit this server writes carries. */
const AUTHOR = 'forge <forge@example.invalid> 1704067200 +0000';

// ---------------------------------------------------------------------------------------------
// Replies

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

/** A GitHub-shaped error: `{"message": ...}`, as every 4xx body must be. */
function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

/** A deterministic request id: a counter, never a clock, so a replay reaches the same header. */
let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `FORGE:${requestCounter.toString(16).toUpperCase().padStart(8, '0')}`;
}

/** The path of a request URL, or '/' when it does not parse. */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The query of a request URL, empty when it does not parse. */
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Read a request body; a body too large for a forge request is refused as null. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON object body; null when it is not one (the caller answers 400). */
function parseJsonBody(body: Buffer): Record<string, unknown> | null {
  if (body.byteLength === 0) return {};
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

// ---------------------------------------------------------------------------------------------
// Identity: the token names one login, learned from the first owner-carrying request

/** The login the bearer token owns, once a request has named it. */
let authLogin: string | null = null;

/** Whether a request carries this forge's token; every route but /healthz requires it. */
function isAuthenticated(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${TOKEN}`;
}

/** Move a repository (and its refs, labels, issues and pulls) to a new owner. */
function adopt(repo: Repo, owner: string): void {
  const from = store.key(repo.owner, repo.name);
  const to = store.key(owner, repo.name);
  if (from === to) return;
  store.repos.delete(from);
  for (const map of [store.refs, store.headSymref, store.labels, store.issues, store.pulls] as Map<string, unknown>[]) {
    const value = map.get(from);
    if (value !== undefined) {
      map.delete(from);
      map.set(to, value);
    }
  }
  repo.owner = owner;
  store.repos.set(to, repo);
}

/**
 * The repository at `owner/name`. A repository created before the token's login was known is
 * adopted by the first owner-carrying request, which is how a repository made through
 * POST /user/repos answers at /repos/<its owner>/<its name> without the forge ever being told
 * the login: the same name under any other owner stays absent, so it is a 404 there.
 */
function findRepo(owner: string, name: string): Repo | undefined {
  const exact = store.getRepo(owner, name);
  if (exact !== undefined) {
    if (authLogin === null) authLogin = exact.owner;
    return exact;
  }
  if (authLogin !== null && owner.toLowerCase() !== authLogin.toLowerCase()) return undefined;
  const pending = store.getRepo(PENDING_OWNER, name);
  if (pending === undefined) return undefined;
  adopt(pending, owner);
  authLogin = owner;
  return pending;
}

/** The login repository writes are attributed to, once a repository exists. */
function currentLogin(): string {
  return authLogin ?? PENDING_OWNER;
}

// ---------------------------------------------------------------------------------------------
// Repositories

function repoJson(repo: Repo): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: full,
    owner: userJson(repo.owner),
    private: repo.private,
    html_url: `/${full}`,
    description: repo.description,
    fork: repo.fork,
    url: `/api/v3/repos/${full}`,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    homepage: repo.homepage,
    topics: repo.topics,
    archived: repo.archived,
    visibility: repo.visibility,
    has_issues: repo.hasIssues,
    open_issues_count: store.repoIssues(repo.owner, repo.name).filter((issue) => issue.state === 'open').length,
  };
}

function userJson(login: string): Record<string, unknown> {
  const user = store.addUser(login);
  return {
    login: user.login,
    id: user.id,
    node_id: `U_${user.id}`,
    type: user.type,
    site_admin: user.siteAdmin,
    url: `/api/v3/users/${user.login}`,
  };
}

function listRepos(login: string, perPage: number, page: number): { items: Repo[]; hasNext: boolean; hasPrev: boolean } {
  const all = store.reposOf(login);
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  return { items, hasNext: start + items.length < all.length, hasPrev: page > 1 };
}

/** GitHub's pagination header for a paged list; the URLs stay on the entry's own origin. */
function linkHeader(req: IncomingMessage, path: string, query: URLSearchParams, page: number, perPage: number, hasNext: boolean, hasPrev: boolean, lastPage: number): string {
  const host = req.headers.host ?? 'entry';
  const pageUrl = (n: number): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(n));
    return `http://${host}${path}?${params.toString()}`;
  };
  const parts: string[] = [];
  if (hasNext) parts.push(`<${pageUrl(page + 1)}>; rel="next"`, `<${pageUrl(lastPage)}>; rel="last"`);
  if (hasPrev) parts.push(`<${pageUrl(page - 1)}>; rel="prev"`, `<${pageUrl(1)}>; rel="first"`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------------------------
// Commits and contents

interface CommitInfo {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
}

/** One stored commit, read out of the object store. */
function commitInfo(sha: string): CommitInfo | undefined {
  const obj = getObject(sha);
  if (obj === undefined || obj.type !== 'commit') return undefined;
  const text = obj.data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const parsed = parseCommit(obj.data);
  return { sha, tree: parsed.tree, parents: parsed.parents, message };
}

function commitJson(sha: string): Record<string, unknown> | undefined {
  const info = commitInfo(sha);
  if (info === undefined) return undefined;
  return {
    sha: info.sha,
    node_id: `C_${info.sha.slice(0, 12)}`,
    url: `/api/v3/commits/${info.sha}`,
    html_url: `/commit/${info.sha}`,
    commit: {
      message: info.message,
      author: { name: 'forge', email: 'forge@example.invalid', date: EPOCH_ISO },
      committer: { name: 'forge', email: 'forge@example.invalid', date: EPOCH_ISO },
      tree: { sha: info.tree, url: `/api/v3/trees/${info.tree}` },
    },
    parents: info.parents.map((parent) => ({ sha: parent, url: `/api/v3/commits/${parent}` })),
  };
}

/** The commits reachable from a tip, newest first (the order a branch walk gives). */
function commitsFrom(tip: string | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = tip === undefined ? [] : [tip];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    out.push(sha);
    const info = commitInfo(sha);
    if (info !== undefined) queue.push(...info.parents);
  }
  return out;
}

/** The files of a commit's tree, flattened to path -> {sha, mode}. */
function filesOf(commitSha: string | undefined): Map<string, { sha: string; mode: string }> {
  if (commitSha === undefined) return new Map();
  const info = commitInfo(commitSha);
  if (info === undefined) return new Map();
  return flattenTree(info.tree);
}

/** Write a blob and a commit over `files`, then move `ref` to it. */
function commitFiles(repo: Repo, ref: string, files: Map<string, { sha: string; mode: string }>, message: string, parent: string | undefined): string {
  const tree = writeFlatTree(files);
  const commitSha = writeCommit({
    tree,
    parents: parent === undefined ? [] : [parent],
    author: AUTHOR,
    committer: AUTHOR,
    message,
  });
  store.repoRefs(repo.owner, repo.name).set(ref, commitSha);
  repo.pushedAt = EPOCH_ISO;
  return commitSha;
}

function refSha(repo: Repo, ref: string): string | undefined {
  return store.repoRefs(repo.owner, repo.name).get(ref);
}

function branchSha(repo: Repo, branch: string): string | undefined {
  return refSha(repo, `refs/heads/${branch}`);
}

/** The blob id and size of a path at a commit, or undefined when the path is not a file there. */
function readFile(repo: Repo, commitSha: string | undefined, path: string): { sha: string; size: number } | undefined {
  const files = filesOf(commitSha);
  const entry = files.get(path);
  if (entry === undefined) return undefined;
  const blob = getObject(entry.sha);
  return { sha: entry.sha, size: blob === undefined ? 0 : blob.data.byteLength };
}

function b64(buffer: Buffer): string {
  return buffer.toString('base64');
}

// ---------------------------------------------------------------------------------------------
// Issues, comments and labels

interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

const comments = new Map<string, Comment[]>();

function commentsOf(repo: Repo, issueNumber: number): Comment[] {
  const key = `${store.key(repo.owner, repo.name)}#${issueNumber}`;
  let list = comments.get(key);
  if (list === undefined) {
    list = [];
    comments.set(key, list);
  }
  return list;
}

let nextCommentId = 400000;

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const found = store.repoLabels(repo.owner, repo.name).find((label) => label.name === name);
  return {
    id: found?.id ?? 0,
    node_id: `L_${name}`,
    name,
    color: found?.color ?? 'ededed',
    description: found?.description ?? '',
    default: false,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.stateReason,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(issue.author),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: commentsOf(repo, issue.number).length,
    locked: issue.locked,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const baseSha = branchSha(repo, pull.base) ?? '';
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.author),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merged: pull.merged,
    mergeable: pull.mergeable,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Pull request files and merges

interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

/** The paths a pull request's head branch changed against its base branch. */
function pullFiles(repo: Repo, pull: Pull): PullFile[] {
  const baseFiles = filesOf(branchSha(repo, pull.base));
  const headFiles = filesOf(pull.headSha);
  const out: PullFile[] = [];
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (head !== undefined && base !== undefined && head.sha === base.sha) continue;
    const headBytes = head === undefined ? undefined : getObject(head.sha);
    const baseBytes = base === undefined ? undefined : getObject(base.sha);
    const added = headBytes === undefined ? 0 : headBytes.data.toString('utf8').split('\n').length;
    const removed = baseBytes === undefined ? 0 : baseBytes.data.toString('utf8').split('\n').length;
    out.push({
      filename: path,
      status: base === undefined ? 'added' : head === undefined ? 'removed' : 'modified',
      additions: base === undefined ? Math.max(1, added) : added,
      deletions: base === undefined ? 0 : removed,
      changes: added + removed,
      sha: head?.sha ?? base?.sha ?? '',
    });
  }
  return out;
}

/** The squash merge: the head branch's changed paths applied to the base tip, as one commit. */
function squashMerge(repo: Repo, pull: Pull): { sha: string } | { conflict: true } {
  const baseBranch = pull.base;
  const baseTip = branchSha(repo, baseBranch);
  const baseShaAtCreate = pullBaseSha.get(`${store.key(repo.owner, repo.name)}#${pull.number}`) ?? '';
  const baseAtCreate = filesOf(baseShaAtCreate === '' ? undefined : baseShaAtCreate);
  const headFiles = filesOf(pull.headSha);
  const baseNow = filesOf(baseTip);
  const changed = new Set<string>();
  for (const [path, entry] of headFiles) {
    const base = baseAtCreate.get(path);
    if (base === undefined || base.sha !== entry.sha) changed.add(path);
  }
  for (const path of baseAtCreate.keys()) {
    if (!headFiles.has(path)) changed.add(path);
  }
  // A path that moved on the base branch since the pull request opened is a conflict: the
  // squash would silently carry over work the base branch already replaced.
  for (const path of changed) {
    const then = baseAtCreate.get(path)?.sha ?? '';
    const now = baseNow.get(path)?.sha ?? '';
    if (then !== now) return { conflict: true };
  }
  const merged = new Map(baseNow);
  for (const path of changed) {
    const entry = headFiles.get(path);
    if (entry === undefined) merged.delete(path);
    else merged.set(path, entry);
  }
  const sha = commitFiles(repo, `refs/heads/${baseBranch}`, merged, `Merge pull request #${pull.number}`, baseTip);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = EPOCH_ISO;
  pull.closedAt = EPOCH_ISO;
  pull.mergeCommitSha = sha;
  pull.updatedAt = EPOCH_ISO;
  return { sha };
}

/** The base tip each pull request was opened from, by `<repoKey>#<number>`. */
const pullBaseSha = new Map<string, string>();

// ---------------------------------------------------------------------------------------------
// The router

type Route = (req: IncomingMessage, res: ServerResponse, match: string[], query: URLSearchParams) => Promise<void> | void;

interface RouteSpec {
  method: string;
  pattern: RegExp;
  run: Route;
}

const routes: RouteSpec[] = [];

/** Register a route; `pattern` is matched against the path below /api/v3. */
function route(method: string, pattern: RegExp, run: Route): void {
  routes.push({ method, pattern, run });
}

// The API root and its metadata.
route('GET', /^\/?$/, (req, res) => {
  sendJson(res, 200, {
    current_user_url: '/api/v3/user',
    repository_url: '/api/v3/repos/{owner}/{repo}',
    user_repositories_url: '/api/v3/user/repos',
    rate_limit_url: '/api/v3/rate_limit',
  }, { 'x-oauth-scopes': 'repo, read:org' });
});

route('GET', /^\/meta$/, (req, res) => {
  sendJson(res, 200, { installed_version: '3.0.0', verifiable_password_authentication: true });
});

// GET /user and GET /user/repos, POST /user/repos
route('GET', /^\/user$/, (req, res) => {
  sendJson(res, 200, userJson(currentLogin() === PENDING_OWNER ? 'forge' : currentLogin()));
});

route('GET', /^\/user\/repos$/, (req, res, _m, query) => {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const login = currentLogin();
  const { items, hasNext, hasPrev } = listRepos(login, perPage, page);
  const total = store.reposOf(login).length;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const headers: Record<string, string> = {};
  const link = linkHeader(req, '/api/v3/user/repos', query, page, perPage, hasNext, hasPrev, lastPage);
  if (link !== '') headers.link = link;
  sendJson(res, 200, items.map(repoJson), headers);
});

route('POST', /^\/user\/repos$/, async (req, res) => {
  const body = parseJsonBody(await readBody(req));
  if (body === null) return sendError(res, 400, 'Problems parsing JSON');
  const name = str(body.name);
  if (name === '') return sendError(res, 422, 'Repository creation failed: name is required');
  const owner = currentLogin();
  if (store.getRepo(owner, name) !== undefined) return sendError(res, 422, `Repository creation failed: ${owner}/${name} already exists`);
  const repo = store.createRepo(owner, name, str(body.description), bool(body.private) === true);
  const branch = str(body.default_branch);
  if (branch !== '') {
    repo.defaultBranch = branch;
    store.headSymref.set(store.key(repo.owner, repo.name), `refs/heads/${branch}`);
  }
  sendJson(res, 201, repoJson(repo));
});

// /repos/{owner}/{repo}
route('GET', /^\/repos\/([^/]+)\/([^/]+)$/, (req, res, match) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  sendJson(res, 200, repoJson(repo));
});

route('PATCH', /^\/repos\/([^/]+)\/([^/]+)$/, async (req, res, match) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const body = parseJsonBody(await readBody(req));
  if (body === null) return sendError(res, 400, 'Problems parsing JSON');
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.name === 'string' && body.name !== '') repo.name = body.name;
  if (typeof body.private === 'boolean') {
    repo.private = body.private;
    repo.visibility = body.private ? 'private' : 'public';
  }
  repo.updatedAt = EPOCH_ISO;
  sendJson(res, 200, repoJson(repo));
});

route('DELETE', /^\/repos\/([^/]+)\/([^/]+)$/, (req, res, match) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  store.deleteRepo(repo.owner, repo.name);
  res.writeHead(204, { 'x-github-request-id': requestId() });
  res.end();
});

// POST /repos/{o}/{r}/git/refs
route('POST', /^\/repos\/([^/]+)\/([^/]+)\/git\/refs$/, async (req, res, match) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const body = parseJsonBody(await readBody(req));
  if (body === null) return sendError(res, 400, 'Problems parsing JSON');
  const ref = str(body.ref);
  const sha = str(body.sha);
  if (ref === '' || sha === '') return sendError(res, 422, 'Reference update failed: ref and sha are required');
  if (getObject(sha) === undefined) return sendError(res, 422, `Reference update failed: no commit ${sha}`);
  store.repoRefs(repo.owner, repo.name).set(ref.startsWith('refs/') ? ref : `refs/heads/${ref}`, sha);
  sendJson(res, 201, { ref, node_id: `REF_${ref}`, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${ref}`, object: { sha, type: 'commit', url: `/api/v3/commits/${sha}` } });
});

// GET /repos/{o}/{r}/branches
route('GET', /^\/repos\/([^/]+)\/([^/]+)\/branches$/, (req, res, match) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const heads = store.repoRefs(repo.owner, repo.name);
  const out: Record<string, unknown>[] = [];
  for (const [ref, sha] of heads) {
    if (!ref.startsWith('refs/heads/')) continue;
    out.push({
      name: ref.slice('refs/heads/'.length),
      commit: { sha, url: `/api/v3/commits/${sha}` },
      protected: false,
    });
  }
  sendJson(res, 200, out);
});

// GET /repos/{o}/{r}/commits[?sha=<branch>]
route('GET', /^\/repos\/([^/]+)\/([^/]+)\/commits$/, (req, res, match, query) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const wanted = query.get('sha') ?? repo.defaultBranch;
  let tip = branchSha(repo, wanted);
  if (tip === undefined && /^[0-9a-f]{40}$/i.test(wanted)) tip = wanted;
  const out: Record<string, unknown>[] = [];
  for (const sha of commitsFrom(tip ?? branchSha(repo, repo.defaultBranch))) {
    const json = commitJson(sha);
    if (json !== undefined) out.push(json);
  }
  sendJson(res, 200, out);
});

// PUT /repos/{o}/{r}/contents/{path}
route('PUT', /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/, async (req, res, match) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const path = decodeURIComponent(match[2] as string);
  const body = parseJsonBody(await readBody(req));
  if (body === null) return sendError(res, 400, 'Problems parsing JSON');
  const message = str(body.message) === '' ? `Update ${path}` : str(body.message);
  const branch = str(body.branch) === '' ? repo.defaultBranch : str(body.branch);
  const content = Buffer.from(str(body.content), 'base64');
  const tip = branchSha(repo, branch);
  const files = filesOf(tip);
  const existing = files.get(path);
  const expectedSha = str(body.sha);
  if (expectedSha !== '' && (existing === undefined || existing.sha !== expectedSha)) {
    return sendError(res, 409, `Conflict: ${path} is at ${existing?.sha ?? 'no blob'}, not ${expectedSha}`);
  }
  if (expectedSha === '' && existing !== undefined) {
    return sendError(res, 422, `Invalid request: ${path} already exists; send its sha to update it`);
  }
  const blobSha = putObject('blob', content);
  files.set(path, { sha: blobSha, mode: '100644' });
  const commitSha = commitFiles(repo, `refs/heads/${branch}`, files, message, tip);
  const name = path.split('/').pop() ?? path;
  sendJson(res, existing === undefined ? 201 : 200, {
    content: {
      name,
      path,
      sha: blobSha,
      size: content.byteLength,
      encoding: 'base64',
      content: b64(content),
      type: 'file',
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    },
    commit: {
      sha: commitSha,
      node_id: `C_${commitSha.slice(0, 12)}`,
      message,
      author: { name: 'forge', email: 'forge@example.invalid', date: EPOCH_ISO },
      tree: { sha: commitInfo(commitSha)?.tree ?? '', url: '' },
    },
  });
});

// GET /repos/{o}/{r}/contents/{path}[?ref=]
route('GET', /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/, (req, res, match, query) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const path = decodeURIComponent(match[2] as string).replace(/\/+$/, '');
  const ref = query.get('ref') ?? repo.defaultBranch;
  const commitSha = branchSha(repo, ref) ?? (/^[0-9a-f]{40}$/i.test(ref) ? ref : undefined);
  const files = filesOf(commitSha);
  const entry = files.get(path);
  if (entry !== undefined) {
    const blob = getObject(entry.sha);
    const bytes = blob === undefined ? Buffer.alloc(0) : blob.data;
    return sendJson(res, 200, {
      type: 'file',
      name: path.split('/').pop() ?? path,
      path,
      sha: entry.sha,
      size: bytes.byteLength,
      encoding: 'base64',
      content: b64(bytes),
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.sha}`,
      download_url: null,
    });
  }
  // A directory listing: every entry one level below `path`.
  const prefix = path === '' ? '' : `${path}/`;
  const listing: Record<string, unknown>[] = [];
  const seenDirs = new Set<string>();
  for (const [filePath, value] of files) {
    if (prefix !== '' && !filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    const name = slash === -1 ? rest : rest.slice(0, slash);
    const childPath = `${prefix}${name}`;
    if (slash === -1) {
      listing.push({ type: 'file', name, path: childPath, sha: value.sha, size: getObject(value.sha)?.data.byteLength ?? 0, encoding: 'base64', url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${childPath}` });
    } else if (!seenDirs.has(childPath)) {
      seenDirs.add(childPath);
      listing.push({ type: 'dir', name, path: childPath, sha: value.sha, size: 0, url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${childPath}` });
    }
  }
  if (listing.length === 0) return sendError(res, 404, 'Not Found');
  sendJson(res, 200, listing);
});

// DELETE /repos/{o}/{r}/contents/{path}
route('DELETE', /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/, async (req, res, match) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const path = decodeURIComponent(match[2] as string);
  const body = parseJsonBody(await readBody(req));
  if (body === null) return sendError(res, 400, 'Problems parsing JSON');
  const branch = str(body.branch) === '' ? repo.defaultBranch : str(body.branch);
  const message = str(body.message) === '' ? `Delete ${path}` : str(body.message);
  const tip = branchSha(repo, branch);
  const files = filesOf(tip);
  if (!files.has(path)) return sendError(res, 404, 'Not Found');
  files.delete(path);
  const commitSha = commitFiles(repo, `refs/heads/${branch}`, files, message, tip);
  sendJson(res, 200, { content: null, commit: { sha: commitSha, message, author: { name: 'forge', email: 'forge@example.invalid', date: EPOCH_ISO } } });
});

// POST /repos/{o}/{r}/labels
route('POST', /^\/repos\/([^/]+)\/([^/]+)\/labels$/, async (req, res, match) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const body = parseJsonBody(await readBody(req));
  if (body === null) return sendError(res, 400, 'Problems parsing JSON');
  const name = str(body.name);
  if (name === '') return sendError(res, 422, 'Validation Failed: name is required');
  const existing = store.repoLabels(repo.owner, repo.name).find((label) => label.name === name);
  if (existing !== undefined) return sendJson(res, 200, labelJson(repo, name));
  store.newLabel(repo, name, str(body.color) === '' ? 'ededed' : str(body.color), str(body.description));
  sendJson(res, 201, labelJson(repo, name));
});

route('GET', /^\/repos\/([^/]+)\/([^/]+)\/labels$/, (req, res, match) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  sendJson(res, 200, store.repoLabels(repo.owner, repo.name).map((label) => labelJson(repo, label.name)));
});

// POST /repos/{o}/{r}/issues
route('POST', /^\/repos\/([^/]+)\/([^/]+)\/issues$/, async (req, res, match) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const body = parseJsonBody(await readBody(req));
  if (body === null) return sendError(res, 400, 'Problems parsing JSON');
  const title = str(body.title);
  if (title === '') return sendError(res, 422, 'Validation Failed: title is required');
  const requested = Array.isArray(body.labels) ? (body.labels as unknown[]) : [];
  const known = store.repoLabels(repo.owner, repo.name).map((label) => label.name);
  const labels: string[] = [];
  for (const item of requested) {
    const name = typeof item === 'string' ? item : str((item as Record<string, unknown>)?.name);
    if (name === '') continue;
    if (!known.includes(name)) return sendError(res, 422, `Validation Failed: ${name} does not match any label`);
    labels.push(name);
  }
  const issue = store.newIssue(repo, currentLogin(), title, str(body.body), labels);
  sendJson(res, 201, issueJson(repo, issue));
});

// GET /repos/{o}/{r}/issues?state=&sort=&direction=&per_page=
route('GET', /^\/repos\/([^/]+)\/([^/]+)\/issues$/, (req, res, match, query) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const state = query.get('state') ?? 'open';
  const direction = (query.get('direction') ?? 'desc').toLowerCase();
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  let list = store.repoIssues(repo.owner, repo.name).slice();
  if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
  list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  sendJson(res, 200, list.slice(0, perPage).map((issue) => issueJson(repo, issue)));
});

// GET /repos/{o}/{r}/issues/{n} and PATCH it
route('GET', /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/, (req, res, match) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const issue = store.repoIssues(repo.owner, repo.name).find((item) => item.number === Number(match[2]));
  if (issue === undefined) return sendError(res, 404, 'Not Found');
  sendJson(res, 200, issueJson(repo, issue));
});

route('PATCH', /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/, async (req, res, match) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const issue = store.repoIssues(repo.owner, repo.name).find((item) => item.number === Number(match[2]));
  if (issue === undefined) return sendError(res, 404, 'Not Found');
  const body = parseJsonBody(await readBody(req));
  if (body === null) return sendError(res, 400, 'Problems parsing JSON');
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'closed' || body.state === 'open') {
    issue.state = body.state;
    issue.closedAt = body.state === 'closed' ? EPOCH_ISO : null;
  }
  issue.updatedAt = EPOCH_ISO;
  sendJson(res, 200, issueJson(repo, issue));
});

// POST and GET /repos/{o}/{r}/issues/{n}/comments
route('POST', /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, async (req, res, match) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const number = Number(match[2]);
  const issue = store.repoIssues(repo.owner, repo.name).find((item) => item.number === number);
  if (issue === undefined) return sendError(res, 404, 'Not Found');
  const body = parseJsonBody(await readBody(req));
  if (body === null) return sendError(res, 400, 'Problems parsing JSON');
  const text = str(body.body);
  if (text === '') return sendError(res, 422, 'Validation Failed: body is required');
  nextCommentId += 1;
  const comment: Comment = { id: nextCommentId, body: text, createdAt: EPOCH_ISO };
  commentsOf(repo, number).push(comment);
  sendJson(res, 201, commentJson(repo, number, comment));
});

route('GET', /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, (req, res, match) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const number = Number(match[2]);
  sendJson(res, 200, commentsOf(repo, number).map((comment) => commentJson(repo, number, comment)));
});

function commentJson(repo: Repo, number: number, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: userJson(currentLogin() === PENDING_OWNER ? 'forge' : currentLogin()),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
  };
}

// POST /repos/{o}/{r}/pulls
route('POST', /^\/repos\/([^/]+)\/([^/]+)\/pulls$/, async (req, res, match) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const body = parseJsonBody(await readBody(req));
  if (body === null) return sendError(res, 400, 'Problems parsing JSON');
  const head = str(body.head);
  const base = str(body.base) === '' ? repo.defaultBranch : str(body.base);
  if (head === '') return sendError(res, 422, 'Validation Failed: head is required');
  const headSha = branchSha(repo, head);
  if (headSha === undefined) return sendError(res, 422, `Validation Failed: no branch ${head}`);
  const baseSha = branchSha(repo, base);
  if (baseSha === undefined) return sendError(res, 422, `Validation Failed: no branch ${base}`);
  const pull = store.newPull(repo, currentLogin(), str(body.title), str(body.body), head, base);
  pull.headSha = headSha;
  pull.mergeable = true;
  pullBaseSha.set(`${store.key(repo.owner, repo.name)}#${pull.number}`, baseSha);
  sendJson(res, 201, pullJson(repo, pull));
});

// GET /repos/{o}/{r}/pulls?state=all|open|closed
route('GET', /^\/repos\/([^/]+)\/([^/]+)\/pulls$/, (req, res, match, query) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const state = query.get('state') ?? 'open';
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  let list = store.repoPulls(repo.owner, repo.name).slice();
  if (state === 'open' || state === 'closed') list = list.filter((pull) => pull.state === state);
  list.sort((a, b) => b.number - a.number);
  sendJson(res, 200, list.slice(0, perPage).map((pull) => pullJson(repo, pull)));
});

// GET /repos/{o}/{r}/pulls/{n}
route('GET', /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/, (req, res, match) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const pull = store.repoPulls(repo.owner, repo.name).find((item) => item.number === Number(match[2]));
  if (pull === undefined) return sendError(res, 404, 'Not Found');
  sendJson(res, 200, pullJson(repo, pull));
});

// GET /repos/{o}/{r}/pulls/{n}/files
route('GET', /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/, (req, res, match) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const pull = store.repoPulls(repo.owner, repo.name).find((item) => item.number === Number(match[2]));
  if (pull === undefined) return sendError(res, 404, 'Not Found');
  sendJson(res, 200, pullFiles(repo, pull));
});

// PUT /repos/{o}/{r}/pulls/{n}/merge
route('PUT', /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/, async (req, res, match) => {
  const repo = findRepo(match[0] as string, match[1] as string);
  if (repo === undefined) return sendError(res, 404, 'Not Found');
  const pull = store.repoPulls(repo.owner, repo.name).find((item) => item.number === Number(match[2]));
  if (pull === undefined) return sendError(res, 404, 'Not Found');
  if (pull.state !== 'open') return sendError(res, 405, 'Pull request is not mergeable');
  const result = squashMerge(repo, pull);
  if ('conflict' in result) return sendError(res, 405, 'Pull request is not mergeable: the base branch moved');
  sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
});

// ---------------------------------------------------------------------------------------------
// The server

/** One request: authenticate, strip the /api/v3 prefix, and answer from the routes. */
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = (req.method ?? 'GET').toUpperCase();

  if (method === 'GET' && path === '/healthz') return sendJson(res, 200, { ok: true });

  if (!isAuthenticated(req)) return sendError(res, 401, 'Requires authentication');

  if (!path.startsWith('/api/v3')) return sendError(res, 404, 'Not Found');
  const rest = path.slice('/api/v3'.length);
  const query = queryOf(req);
  for (const spec of routes) {
    if (spec.method !== method) continue;
    const match = spec.pattern.exec(rest);
    if (match === null) continue;
    return spec.run(req, res, match.slice(1), query);
  }
  sendError(res, 404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens on an ephemeral port. */
export function createApp(): Server {
  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendError(res, 400, `Problems parsing JSON: ${message}`);
      else res.end();
    });
  });
  // git smart HTTP and MCP will be mounted here; until then they are the JSON 404 above.
  return server;
}