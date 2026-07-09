/*
  Engine9 client modification logging.

  Every write through the client API is (1) saved to the database and then
  (2) appended to a modification log for long-term storage and downstream
  processing.  Two logger styles:

    JsonlFileLogger  -- generic deployments: appends JSON lines to a local
                        file (one file per day), suitable for shipping to
                        object storage.
    BatchLogger      -- Cloudflare-style batch logging: buffers records in
                        memory and flushes batches to a sink you provide
                        (R2 bucket, Queue, Logpush endpoint, console).
                        Call `flush()` inside ctx.waitUntil() per request,
                        or let maxRecords trigger it.

  Log record shape (one per modification):
    { ts, accountId, action, table?, records?, personIds?, apiKeyId?, meta? }
*/

function logRecord(entry) {
  return { ts: new Date().toISOString(), ...entry };
}

/* Generic node deployments: append JSONL to <directory>/engine9-modifications-YYYY-MM-DD.jsonl */
export class JsonlFileLogger {
  constructor({ directory = '.', prefix = 'engine9-modifications' } = {}) {
    this.directory = directory;
    this.prefix = prefix;
  }
  filename() {
    const day = new Date().toISOString().slice(0, 10);
    return `${this.directory.replace(/\/$/, '')}/${this.prefix}-${day}.jsonl`;
  }
  async log(entry) {
    const { appendFile, mkdir } = await import('node:fs/promises');
    await mkdir(this.directory, { recursive: true });
    await appendFile(this.filename(), `${JSON.stringify(logRecord(entry))}\n`);
  }
  async flush() {} // appends are immediate
}

/* Cloudflare-style batch logger.  `sink` receives an array of records:
     new BatchLogger({ sink: async (records) => env.LOG_BUCKET.put(key, JSON.stringify(records)) })
   or for Cloudflare Queues:
     new BatchLogger({ sink: (records) => env.LOG_QUEUE.sendBatch(records.map((body) => ({ body }))) })
*/
export class BatchLogger {
  constructor({ sink, maxRecords = 250 } = {}) {
    if (typeof sink !== 'function') throw new Error('BatchLogger requires a sink function');
    this.sink = sink;
    this.maxRecords = maxRecords;
    this.buffer = [];
  }
  async log(entry) {
    this.buffer.push(logRecord(entry));
    if (this.buffer.length >= this.maxRecords) await this.flush();
  }
  async flush() {
    if (this.buffer.length === 0) return;
    const records = this.buffer;
    this.buffer = [];
    await this.sink(records);
  }
}

/* Sink helper for Cloudflare R2: writes each batch as a timestamped JSONL object */
export function r2Sink(bucket, { prefix = 'modifications' } = {}) {
  return async (records) => {
    const key = `${prefix}/${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.jsonl`;
    await bucket.put(key, records.map((r) => JSON.stringify(r)).join('\n'));
  };
}

/* No-op logger for tests / opt-out */
export class NullLogger {
  async log() {}
  async flush() {}
}

export default { JsonlFileLogger, BatchLogger, NullLogger, r2Sink };
