import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildRequest, main, outputPaths, parseArgs, readEnvFile, UsageError } from '../src/cli.mjs';

const KEY = 'sk-test-key';
const temp = () => mkdtempSync(join(tmpdir(), 'pixai-cli-'));

/** A fake PixAI: one create call, then the given statuses, then an image. */
function fakePixai({ statuses = ['running', 'completed'], media = ['https://cdn.example/a/image.webp'] } = {}) {
  const calls = [];
  const queue = [...statuses];
  const reply = (status, body) => ({
    ok: status < 400,
    status,
    statusText: '',
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new TextEncoder().encode('image-bytes').buffer,
  });
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers, body: init.body && JSON.parse(init.body) });
    if (init.headers && init.headers.Authorization !== `Bearer ${KEY}`) return reply(401, { message: 'unauthorized' });
    if (url.endsWith('/v2/image/create')) return reply(200, { id: 'task-1', status: 'waiting' });
    if (url.includes('/v1/task/')) {
      const status = queue.length > 1 ? queue.shift() : queue[0];
      return reply(200, { id: 'task-1', status, outputs: status === 'completed' ? { mediaUrls: media } : {} });
    }
    return reply(200, {});
  };
  return { fetch, calls };
}

async function run(args, { env = { PIXAI_API_KEY: KEY }, pixai = fakePixai() } = {}) {
  const stdout = [];
  const stderr = [];
  const code = await main(args, {
    env,
    fetch: pixai.fetch,
    sleep: async () => {},
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), calls: pixai.calls };
}

test('parses flags, inline values and repeated params', () => {
  const options = parseArgs(['generate', '-p', 'a cat', '--aspect=9:16', '--param', 'seed=7', '--param', 'tag=x', '--force']);
  assert.deepEqual(options.positional, ['generate']);
  assert.equal(options.prompt, 'a cat');
  assert.equal(options.aspect, '9:16');
  assert.deepEqual(options.params, { seed: 7, tag: 'x' });
  assert.equal(options.force, true);
  assert.throws(() => parseArgs(['generate', '--nope']), UsageError);
  assert.throws(() => parseArgs(['generate', '--prompt']), UsageError);
});

test('builds the request body and requires a prompt and model', () => {
  assert.deepEqual(
    buildRequest({ prompt: 'p', negative: 'n', model: '123', aspect: '9:16', size: '1.5k', mode: 'pro', promptHelper: 'disable', params: { seed: 1 } }),
    { modelVersionId: '123', prompt: 'p', negativePrompt: 'n', aspectRatio: '9:16', size: '1.5k', mode: 'pro', promptHelper: 'disable', batchSize: 1, seed: 1 },
  );
  assert.equal(buildRequest({ prompt: 'p' }, { PIXAI_MODEL_VERSION_ID: '9' }).modelVersionId, '9');
  assert.throws(() => buildRequest({ model: '1' }), /prompt is required/);
  assert.throws(() => buildRequest({ prompt: 'p' }), /model version id is required/);
});

test('names output files after the returned media', () => {
  const paths = outputPaths('out/hero.png', ['https://x/a.webp?sig=1', 'https://x/b.jpg', 'not a url']);
  assert.match(paths[0], /hero\.webp$/);
  assert.match(paths[1], /hero-2\.jpg$/);
  assert.match(paths[2], /hero-3\.png$/);
});

test('reads keys from an env file', () => {
  const file = join(temp(), '.env');
  writeFileSync(file, '# note\nPIXAI_API_KEY="abc"\nexport OTHER=1\n');
  assert.deepEqual(readEnvFile(file), { PIXAI_API_KEY: 'abc', OTHER: '1' });
});

test('generate submits, waits, saves the image and writes a record without the key', async () => {
  const dir = temp();
  const out = join(dir, 'hero.png');
  const result = await run(['generate', '-p', 'a cat', '-m', '123', '-a', '9:16', '-o', out, '--record']);
  assert.equal(result.code, 0, result.stderr);
  const saved = join(dir, 'hero.webp');
  assert.equal(readFileSync(saved, 'utf8'), 'image-bytes');
  assert.equal(result.stdout, saved);
  assert.deepEqual(result.calls[0].body, { modelVersionId: '123', prompt: 'a cat', aspectRatio: '9:16', batchSize: 1 });
  const record = readFileSync(join(dir, 'hero.json'), 'utf8');
  assert.equal(JSON.parse(record).taskId, 'task-1');
  assert.ok(!record.includes(KEY));
  assert.ok(!result.stdout.includes(KEY) && !result.stderr.includes(KEY));
});

test('generate refuses to overwrite before spending a task', async () => {
  const dir = temp();
  writeFileSync(join(dir, 'hero.webp'), 'old');
  const result = await run(['generate', '-p', 'x', '-m', '1', '-o', join(dir, 'hero.png')]);
  assert.equal(result.code, 2);
  assert.equal(result.calls.length, 0);
  assert.equal(readFileSync(join(dir, 'hero.webp'), 'utf8'), 'old');
});

test('generate --no-wait prints the task id only', async () => {
  const result = await run(['generate', '-p', 'x', '-m', '1', '--no-wait', '--json']);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { taskId: 'task-1', status: 'waiting', files: [] });
  assert.equal(result.calls.length, 1);
});

test('a failed task and a bad key exit non-zero', async () => {
  const dir = temp();
  const failed = await run(['generate', '-p', 'x', '-m', '1', '-o', join(dir, 'a.png')], { pixai: fakePixai({ statuses: ['failed'] }) });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /ended with status 'failed'/);
  assert.ok(!existsSync(join(dir, 'a.png')));

  const denied = await run(['task', 'task-1'], { env: { PIXAI_API_KEY: 'wrong' } });
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /401 \(check the API key\)/);

  const missing = await run(['task', 'task-1'], { env: {} });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Missing API key/);
});

test('batch applies defaults, resolves paths beside the jobs file and keeps going after a failure', async () => {
  const dir = temp();
  writeFileSync(join(dir, 'a.txt'), 'prompt from file\n');
  const jobs = join(dir, 'jobs.json');
  writeFileSync(jobs, JSON.stringify({
    defaults: { model: '123', aspect: '9:16', negative: 'bad' },
    jobs: [
      { name: 'first', promptFile: 'a.txt', out: 'out/first.png' },
      { name: 'broken', out: 'out/broken.png' },
      { name: 'third', prompt: 'p3', aspect: '1:1', out: 'out/third.png' },
    ],
  }));
  const result = await run(['batch', jobs, '--json']);
  assert.equal(result.code, 1);
  const rows = JSON.parse(result.stdout);
  assert.deepEqual(rows.map((row) => row.status), ['completed', 'error', 'completed']);
  assert.ok(existsSync(join(dir, 'out', 'first.webp')));
  assert.ok(existsSync(join(dir, 'out', 'third.webp')));
  const created = result.calls.filter((call) => call.method === 'POST').map((call) => call.body);
  assert.deepEqual(created[0], { modelVersionId: '123', prompt: 'prompt from file', negativePrompt: 'bad', aspectRatio: '9:16', batchSize: 1 });
  assert.equal(created[1].aspectRatio, '1:1');
});

test('download saves every image of a finished task', async () => {
  const dir = temp();
  const pixai = fakePixai({ statuses: ['completed'], media: ['https://x/1.png', null, 'https://x/2.png'] });
  const result = await run(['download', 'task-1', '-o', join(dir, 'pick')], { pixai });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(existsSync(join(dir, 'pick.png')));
  assert.ok(existsSync(join(dir, 'pick-2.png')));
});

test('help and unknown commands', async () => {
  assert.equal((await run(['--help'])).code, 0);
  assert.equal((await run([])).code, 1);
  assert.equal((await run(['paint'])).code, 2);
});
