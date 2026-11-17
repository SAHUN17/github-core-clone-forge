// In-memory forge state: users, repositories, issues, pull requests, labels, git objects and refs.
// Everything lives in this process; nothing is persisted and nothing reads the wall clock for data,
// so two runs of the same request sequence produce the same bytes.

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
  type: string;
  siteAdmin: boolean;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  fork: boolean;
  homepage: string;
  topics: string[];
  archived: boolean;
  visibility: string;
  hasIssues: boolean;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  stateReason: string | null;
  labels: string[];
  author: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: number;
  locked: boolean;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  head: string;
  base: string;
  headSha: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  merged: boolean;
  mergeable: boolean | null;
  mergeCommitSha: string | null;
}

export interface GitObject {
  type: string;
  data: Buffer;
}

/** The fixed instant every generated timestamp is derived from (no wall clock reaches the wire). */
export const EPOCH_ISO = '2024-01-01T00:00:00Z';

let nextUserId = 1000;
let nextRepoId = 5000;
let nextIssueId = 100000;
let nextLabelId = 200000;
let nextPullId = 300000;

export class Store {
  users = new Map<string, User>();
  repos = new Map<string, Repo>();
  objects = new Map<string, GitObject>();
  refs = new Map<string, Map<string, string>>();
  headSymref = new Map<string, string>();
  labels = new Map<string, Label[]>();
  issues = new Map<string, Issue[]>();
  pulls = new Map<string, Pull[]>();
  tokens = new Map<string, string>();
  /** Login the bearer token belongs to, once a token has been seen. */
  tokenLogin = new Map<string, string>();
  seq = 0;

  /** A monotonic, deterministic counter shared by every generator that needs a number. */
  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  addUser(login: string): User {
    const existing = this.users.get(login.toLowerCase());
    if (existing !== undefined) return existing;
    nextUserId += 1;
    const user: User = {
      id: nextUserId,
      login,
      name: login,
      email: `${login}@example.invalid`,
      type: 'User',
      siteAdmin: false,
    };
    this.users.set(login.toLowerCase(), user);
    return user;
  }

  key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    nextRepoId += 1;
    const repo: Repo = {
      id: nextRepoId,
      owner,
      name,
      description: description ?? '',
      private: isPrivate === true,
      defaultBranch: 'main',
      createdAt: EPOCH_ISO,
      updatedAt: EPOCH_ISO,
      pushedAt: EPOCH_ISO,
      fork: false,
      homepage: '',
      topics: [],
      archived: false,
      visibility: isPrivate === true ? 'private' : 'public',
      hasIssues: true,
    };
    const k = this.key(owner, name);
    this.repos.set(k, repo);
    this.refs.set(k, new Map());
    this.headSymref.set(k, 'refs/heads/main');
    this.labels.set(k, []);
    this.issues.set(k, []);
    this.pulls.set(k, []);
    return repo;
  }

  deleteRepo(owner: string, name: string): void {
    const k = this.key(owner, name);
    this.repos.delete(k);
    this.refs.delete(k);
    this.headSymref.delete(k);
    this.labels.delete(k);
    this.issues.delete(k);
    this.pulls.delete(k);
  }

  repoRefs(owner: string, name: string): Map<string, string> {
    const k = this.key(owner, name);
    let map = this.refs.get(k);
    if (map === undefined) {
      map = new Map();
      this.refs.set(k, map);
    }
    return map;
  }

  repoLabels(owner: string, name: string): Label[] {
    const k = this.key(owner, name);
    let list = this.labels.get(k);
    if (list === undefined) {
      list = [];
      this.labels.set(k, list);
    }
    return list;
  }

  repoIssues(owner: string, name: string): Issue[] {
    const k = this.key(owner, name);
    let list = this.issues.get(k);
    if (list === undefined) {
      list = [];
      this.issues.set(k, list);
    }
    return list;
  }

  repoPulls(owner: string, name: string): Pull[] {
    const k = this.key(owner, name);
    let list = this.pulls.get(k);
    if (list === undefined) {
      list = [];
      this.pulls.set(k, list);
    }
    return list;
  }

  newIssue(repo: Repo, author: string, title: string, body: string, labels: string[]): Issue {
    const list = this.repoIssues(repo.owner, repo.name);
    nextIssueId += 1;
    const issue: Issue = {
      id: nextIssueId,
      number: list.length + 1,
      title,
      body: body ?? '',
      state: 'open',
      stateReason: null,
      labels,
      author,
      createdAt: EPOCH_ISO,
      updatedAt: EPOCH_ISO,
      closedAt: null,
      comments: 0,
      locked: false,
    };
    list.push(issue);
    return issue;
  }

  newPull(repo: Repo, author: string, title: string, body: string, head: string, base: string): Pull {
    const list = this.repoPulls(repo.owner, repo.name);
    nextPullId += 1;
    const pull: Pull = {
      id: nextPullId,
      number: list.length + 1,
      title,
      body: body ?? '',
      state: 'open',
      head,
      base,
      headSha: '',
      author,
      createdAt: EPOCH_ISO,
      updatedAt: EPOCH_ISO,
      closedAt: null,
      mergedAt: null,
      merged: false,
      mergeable: null,
      mergeCommitSha: null,
    };
    list.push(pull);
    return pull;
  }

  newLabel(repo: Repo, name: string, color: string, description: string): Label {
    const list = this.repoLabels(repo.owner, repo.name);
    nextLabelId += 1;
    const label: Label = { id: nextLabelId, name, color, description };
    list.push(label);
    return label;
  }

  /** All repositories the given login owns, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    const lower = owner.toLowerCase();
    for (const repo of this.repos.values()) {
      if (repo.owner.toLowerCase() === lower) out.push(repo);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }
}

export const store = new Store();