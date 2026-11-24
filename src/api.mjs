// Thin client for the PixAI REST API. No dependencies; needs Node 18+ for fetch.

export const DEFAULT_BASE = 'https://api.pixai.art';
export const TERMINAL = new Set(['completed', 'cancelled', 'failed']);

export class PixaiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'PixaiError';
    this.status = status;
    this.body = body;
  }
}

export function createClient({ apiKey, base = DEFAULT_BASE, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) throw new PixaiError('Missing API key. Set PIXAI_API_KEY or pass --env-file.');
  const root = base.replace(/\/+$/, '');

  async function call(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (cause) {
      throw new PixaiError(`Could not reach PixAI: ${cause.message}`);
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Leave data null; the raw text goes into the error below.
    }
    if (!response.ok) {
      const detail = data?.message || data?.error || text.slice(0, 300) || response.statusText;
      const hint = response.status === 401 ? ' (check the API key)' : '';
      throw new PixaiError(`PixAI returned ${response.status}${hint}: ${detail}`, {
        status: response.status,
        body: data ?? text,
      });
    }
    return data;
  }

  return {
    createImage: (request) => call('POST', '/v2/image/create', request),
    getTask: (id) => call('GET', `/v1/task/${encodeURIComponent(id)}`),

    async waitForTask(id, { intervalMs = 5000, timeoutMs = 15 * 60 * 1000, onStatus, sleep } = {}) {
      const pause = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
      const deadline = Date.now() + timeoutMs;
      let last;
      for (;;) {
        const task = await this.getTask(id);
        const status = String(task?.status ?? 'unknown');
        if (status !== last) {
          onStatus?.(status, task);
          last = status;
        }
        if (TERMINAL.has(status)) return task;
        if (Date.now() >= deadline) {
          throw new PixaiError(`Timed out waiting for task ${id} (last status: ${status}).`);
        }
        await pause(intervalMs);
      }
    },

    async download(url) {
      let response;
      try {
        response = await fetchImpl(url);
      } catch (cause) {
        throw new PixaiError(`Could not download ${url}: ${cause.message}`);
      }
      if (!response.ok) throw new PixaiError(`Download failed with ${response.status}: ${url}`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

export function mediaUrls(task) {
  const urls = task?.outputs?.mediaUrls;
  return (Array.isArray(urls) ? urls : [urls]).filter((url) => typeof url === 'string' && url);
}
