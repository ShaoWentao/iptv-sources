import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function gitBlobSha(content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = Buffer.from(`blob ${buffer.length}\0`);
  return crypto.createHash('sha1').update(header).update(buffer).digest('hex');
}

export function findChangedFiles(files, currentShas) {
  return files
    .map((file) => ({ ...file, blobSha: gitBlobSha(file.content) }))
    .filter((file) => currentShas.get(file.path) !== file.blobSha);
}

function encodePath(value) {
  return String(value).split('/').map(encodeURIComponent).join('/');
}

async function githubRequest({ owner, repo, endpoint, token, method = 'GET', body, fetchImpl = fetch }) {
  const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}${endpoint}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    throw new Error(`${method} ${endpoint} failed: ${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? null : response.json();
}

export async function publishFiles({ owner, repo, branch, token, files, message, fetchImpl = fetch }) {
  if (!owner || !repo || !branch || !token) throw new Error('Missing GitHub repository, branch, or token');
  if (!Array.isArray(files) || files.length === 0) throw new Error('No files supplied for publishing');

  const currentShas = new Map();
  for (const file of files) {
    const metadata = await githubRequest({
      owner,
      repo,
      endpoint: `/contents/${encodePath(file.path)}?ref=${encodeURIComponent(branch)}`,
      token,
      fetchImpl,
    });
    currentShas.set(file.path, metadata.sha);
  }

  const changed = findChangedFiles(files, currentShas);
  if (changed.length === 0) return { changed: [], commitSha: null };

  const encodedBranch = encodePath(branch);
  const ref = await githubRequest({
    owner,
    repo,
    endpoint: `/git/ref/heads/${encodedBranch}`,
    token,
    fetchImpl,
  });
  const parentSha = ref.object.sha;
  const parent = await githubRequest({
    owner,
    repo,
    endpoint: `/git/commits/${parentSha}`,
    token,
    fetchImpl,
  });

  const treeEntries = [];
  for (const file of changed) {
    const blob = await githubRequest({
      owner,
      repo,
      endpoint: '/git/blobs',
      token,
      method: 'POST',
      body: { content: file.content.toString('base64'), encoding: 'base64' },
      fetchImpl,
    });
    treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const tree = await githubRequest({
    owner,
    repo,
    endpoint: '/git/trees',
    token,
    method: 'POST',
    body: { base_tree: parent.tree.sha, tree: treeEntries },
    fetchImpl,
  });
  const commit = await githubRequest({
    owner,
    repo,
    endpoint: '/git/commits',
    token,
    method: 'POST',
    body: { message, tree: tree.sha, parents: [parentSha] },
    fetchImpl,
  });
  await githubRequest({
    owner,
    repo,
    endpoint: `/git/refs/heads/${encodedBranch}`,
    token,
    method: 'PATCH',
    body: { sha: commit.sha, force: false },
    fetchImpl,
  });

  return { changed: changed.map((file) => file.path), commitSha: commit.sha };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
    args[key] = value;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repository = String(process.env.GITHUB_REPOSITORY || '');
  const [owner, repo] = repository.split('/');
  const branch = String(args.branch || process.env.GITHUB_REF_NAME || 'main');
  const token = String(process.env.GITHUB_TOKEN || '');
  const message = String(args.message || 'data: refresh Guangdong Telecom IPTV playlist');
  const paths = [
    'm3u/gd-telecom.m3u',
    'm3u/gd-telecom-report.json',
    'm3u/gd-telecom-epg.xml',
  ];
  const files = paths.map((path) => ({ path, content: fs.readFileSync(path) }));
  const result = await publishFiles({ owner, repo, branch, token, files, message });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}
