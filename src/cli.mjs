import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, parse, resolve } from 'node:path';
import { createClient, mediaUrls, PixaiError, DEFAULT_BASE } from './api.mjs';

const HELP = `pixai — unofficial command-line client for the PixAI image API

Usage
  pixai generate [options]        Create an image and save it
  pixai batch <jobs.json>         Run several jobs from a file
  pixai task <taskId>             Show a task's status
  pixai download <taskId> -o <path>   Save the images of a finished task

Generate options
  -p, --prompt <text>             Prompt text
      --prompt-file <path>        Read the prompt from a file
  -n, --negative <text>           Negative prompt
      --negative-file <path>      Read the negative prompt from a file
  -m, --model <modelVersionId>    Model version id (or PIXAI_MODEL_VERSION_ID)
  -a, --aspect <ratio>            Aspect ratio, e.g. 9:16
  -s, --size <size>               Size, e.g. 1.5k
      --mode <mode>               Generation mode, e.g. pro
  -b, --batch-size <n>            Images per task (default 1)
      --prompt-helper <value>     Prompt helper setting, e.g. disable
      --param <key=value>         Extra request field; repeatable. Values are
                                  parsed as JSON when possible
  -o, --out <path>                Where to save. The extension follows the
                                  image PixAI returns
      --force                     Overwrite existing files
      --no-wait                   Submit and print the task id only
      --record                    Write <out>.json with the request and task id

Shared options
      --env-file <path>           Read PIXAI_API_KEY from a .env file
      --interval <seconds>        Polling interval (default 5)
      --timeout <seconds>         Give up waiting after this long (default 900)
      --json                      Print machine-readable JSON
  -h, --help                      Show this help
  -v, --version                   Show the version

Environment
  PIXAI_API_KEY                   API key (required)
  PIXAI_MODEL_VERSION_ID          Default model version id
  PIXAI_API_BASE                  API base URL (default ${DEFAULT_BASE})
`;

const FLAGS = {
  '-p': 'prompt', '--prompt': 'prompt', '--prompt-file': 'promptFile',
  '-n': 'negative', '--negative': 'negative', '--negative-file': 'negativeFile',
  '-m': 'model', '--model': 'model', '-a': 'aspect', '--aspect': 'aspect',
  '-s': 'size', '--size': 'size', '--mode': 'mode',
  '-b': 'batchSize', '--batch-size': 'batchSize', '--prompt-helper': 'promptHelper',
  '-o': 'out', '--out': 'out', '--env-file': 'envFile',
  '--interval': 'interval', '--timeout': 'timeout',
};
const SWITCHES = {
  '--force': 'force', '--no-wait': 'noWait', '--record': 'record', '--json': 'json',
  '-h': 'help', '--help': 'help', '-v': 'version', '--version': 'version',
};

export class UsageError extends Error {}

export function parseArgs(argv) {
  const options = { params: {}, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    let inline;
    if (arg.startsWith('--') && arg.includes('=')) {
      inline = arg.slice(arg.indexOf('=') + 1);
      arg = arg.slice(0, arg.indexOf('='));
    }
    if (SWITCHES[arg]) {
      options[SWITCHES[arg]] = true;
    } else if (FLAGS[arg] || arg === '--param') {
      const value = inline ?? argv[(i += 1)];
      if (value === undefined) throw new UsageError(`${arg} needs a value.`);
      if (arg === '--param') {
        const at = value.indexOf('=');
        if (at < 1) throw new UsageError('--param expects key=value.');
        options.params[value.slice(0, at)] = jsonOrText(value.slice(at + 1));
      } else {
        options[FLAGS[arg]] = value;
      }
    } else if (arg.startsWith('-') && arg !== '-') {
      throw new UsageError(`Unknown option ${arg}.`);
    } else {
      options.positional.push(arg);
    }
  }
  return options;
}

function jsonOrText(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readText(path, label) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (cause) {
    throw new UsageError(`Could not read ${label} ${path}: ${cause.message}`);
  }
}

export function readEnvFile(path) {
  const values = {};
  for (const line of readText(path, 'env file').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function number(value, label, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`${label} must be a positive number.`);
  return parsed;
}

/** Build the PixAI request body from CLI options or a batch job. */
export function buildRequest(job, env = {}) {
  const prompt = job.prompt ?? (job.promptFile ? readText(job.promptFile, 'prompt file') : undefined);
  if (!prompt) throw new UsageError('A prompt is required (--prompt or --prompt-file).');
  const negative = job.negative ?? (job.negativeFile ? readText(job.negativeFile, 'negative prompt file') : undefined);
  const model = job.model ?? env.PIXAI_MODEL_VERSION_ID;
  if (!model) throw new UsageError('A model version id is required (--model or PIXAI_MODEL_VERSION_ID).');
  const request = { modelVersionId: String(model), prompt };
  if (negative) request.negativePrompt = negative;
  if (job.aspect) request.aspectRatio = job.aspect;
  if (job.size) request.size = job.size;
  if (job.mode) request.mode = job.mode;
  if (job.promptHelper) request.promptHelper = job.promptHelper;
  request.batchSize = Math.round(number(job.batchSize, 'batch size', 1));
  return { ...request, ...(job.params ?? {}) };
}

/** File paths for each returned image: the extension follows the media URL. */
export function outputPaths(out, urls) {
  const { dir, name } = parse(resolve(out));
  return urls.map((url, index) => {
    let extension = '.png';
    try {
      const found = extname(new URL(url).pathname).toLowerCase();
      if (['.png', '.jpg', '.jpeg', '.webp'].includes(found)) extension = found;
    } catch {
      // Keep the default extension for an unparseable URL.
    }
    return join(dir, `${name}${index ? `-${index + 1}` : ''}${extension}`);
  });
}

async function save(client, task, out, { force }) {
  const urls = mediaUrls(task);
  if (!urls.length) throw new PixaiError(`Task ${task?.id} finished without images.`);
  const paths = outputPaths(out, urls);
  const taken = paths.filter((path) => existsSync(path));
  if (taken.length && !force) {
    throw new UsageError(`Refusing to overwrite ${taken.join(', ')}. Pass --force to replace.`);
  }
  for (const [index, path] of paths.entries()) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, await client.download(urls[index]));
  }
  return paths;
}

function ensureCompleted(task, id) {
  if (task?.status !== 'completed') {
    throw new PixaiError(`Task ${id} ended with status '${task?.status}'.`);
  }
}

async function runJob(client, job, env, shared, log) {
  if (!job.noWait && !job.out) throw new UsageError('--out is required unless --no-wait is given.');
  if (job.out && !job.force) {
    const { dir, name } = parse(resolve(job.out));
    const clash = ['.png', '.jpg', '.jpeg', '.webp'].map((ext) => join(dir, name + ext)).filter(existsSync);
    if (clash.length) throw new UsageError(`Refusing to overwrite ${clash.join(', ')}. Pass --force to replace.`);
  }
  const request = buildRequest(job, env);
  const created = await client.createImage(request);
  const id = created?.id ? String(created.id) : '';
  if (!id) throw new PixaiError('PixAI did not return a task id.');
  log(`submitted ${id}`);
  if (job.noWait) return { taskId: id, status: String(created.status ?? 'submitted'), files: [] };

  const task = await client.waitForTask(id, {
    intervalMs: shared.intervalMs,
    timeoutMs: shared.timeoutMs,
    onStatus: (status) => log(`${id}: ${status}`),
    sleep: shared.sleep,
  });
  ensureCompleted(task, id);
  const files = await save(client, task, job.out, { force: job.force });
  for (const file of files) log(`saved ${file}`);
  if (job.record) {
    const recordPath = `${files[0].slice(0, -extname(files[0]).length)}.json`;
    const record = { provider: 'PixAI', taskId: id, createdAt: new Date().toISOString(), request, files };
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    log(`recorded ${recordPath}`);
  }
  return { taskId: id, status: 'completed', files };
}

export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const out = io.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const err = io.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  try {
    const options = parseArgs(argv);
    const [command, ...rest] = options.positional;
    if (options.version) {
      out(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
      return 0;
    }
    if (options.help || !command) {
      out(HELP);
      return command || options.help ? 0 : 1;
    }

    const fileEnv = options.envFile ? readEnvFile(options.envFile) : {};
    const merged = { ...fileEnv, ...env };
    const client = createClient({
      apiKey: merged.PIXAI_API_KEY,
      base: merged.PIXAI_API_BASE || DEFAULT_BASE,
      fetchImpl: io.fetch ?? globalThis.fetch,
    });
    const shared = {
      intervalMs: number(options.interval, '--interval', 5) * 1000,
      timeoutMs: number(options.timeout, '--timeout', 900) * 1000,
      sleep: io.sleep,
    };
    const log = options.json ? () => {} : err;
    const print = (value, text) => out(options.json ? JSON.stringify(value) : text);

    if (command === 'generate') {
      const result = await runJob(client, options, merged, shared, log);
      print(result, result.files.length ? result.files.join('\n') : result.taskId);
      return 0;
    }

    if (command === 'batch') {
      if (!rest[0]) throw new UsageError('batch needs a jobs file.');
      const parsed = jsonOrText(readText(rest[0], 'jobs file'));
      const jobs = Array.isArray(parsed) ? parsed : parsed?.jobs;
      if (!Array.isArray(jobs) || !jobs.length) throw new UsageError('The jobs file must hold a non-empty "jobs" array.');
      const defaults = Array.isArray(parsed) ? {} : parsed.defaults ?? {};
      const base = dirname(resolve(rest[0]));
      const results = [];
      let failed = 0;
      for (const [index, entry] of jobs.entries()) {
        const job = { ...defaults, ...entry, params: { ...defaults.params, ...entry.params } };
        for (const key of ['promptFile', 'negativeFile', 'out']) {
          if (job[key]) job[key] = resolve(base, job[key]);
        }
        if (options.force) job.force = true;
        if (options.record) job.record = true;
        const label = entry.name ?? `job ${index + 1}`;
        try {
          results.push({ name: label, ...(await runJob(client, job, merged, shared, (text) => log(`[${label}] ${text}`))) });
        } catch (error) {
          if (!(error instanceof PixaiError || error instanceof UsageError)) throw error;
          failed += 1;
          results.push({ name: label, status: 'error', error: error.message, files: [] });
          err(`[${label}] ${error.message}`);
        }
      }
      print(results, results.map((r) => `${r.name}: ${r.status}${r.files.length ? ` → ${r.files.join(', ')}` : ''}`).join('\n'));
      return failed ? 1 : 0;
    }

    if (command === 'task') {
      if (!rest[0]) throw new UsageError('task needs a task id.');
      const task = await client.getTask(rest[0]);
      print(task, [`status: ${task?.status}`, ...mediaUrls(task)].join('\n'));
      return 0;
    }

    if (command === 'download') {
      if (!rest[0]) throw new UsageError('download needs a task id.');
      if (!options.out) throw new UsageError('download needs --out.');
      const task = await client.getTask(rest[0]);
      ensureCompleted(task, rest[0]);
      const files = await save(client, task, options.out, { force: options.force });
      print({ taskId: rest[0], files }, files.join('\n'));
      return 0;
    }

    throw new UsageError(`Unknown command ${command}. Run pixai --help.`);
  } catch (error) {
    if (error instanceof UsageError || error instanceof PixaiError) {
      err(`pixai: ${error.message}`);
      return error instanceof UsageError ? 2 : 1;
    }
    throw error;
  }
}
