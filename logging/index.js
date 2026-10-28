/*
  Engine9 logging: two logs, never mixed.

  Data log (`logger`): every write of people data through the client API is
  (1) saved to the database and then (2) appended here for long-term storage
  and downstream processing. Large and constant. Records carry person ids.

  Audit log (`audit`): changes to the database's structure, plugins, keys,
  settings, and who holds a role. A few records per deploy. No people data
  beyond the person id of a role grant. Configured on its own sink (Cloudflare:
  AUDIT_BUCKET, prefix audit/), so access to it never includes access to
  people data. With no audit sink, ConsoleLogger writes each record as one
  JSON line to the Worker log; it is never sent to the data log.

  Logger styles (either log can use any of them):

    JsonlFileLogger  -- generic deployments: appends JSON lines to a local
                        file (one file per day), suitable for shipping to
                        object storage.
    BatchLogger      -- Cloudflare-style batch logging: buffers records in
                        memory and flushes batches to a sink you provide
                        (R2 bucket, Queue, Logpush endpoint).
                        Call `flush()` inside ctx.waitUntil() per request,
                        or let maxRecords trigger it.

    ConsoleLogger    -- audit fallback only: one JSON line per record on the
                        console. Never for the data log: Worker logs are kept
                        and readable by everyone with dashboard access.

  Record shape:
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
  /** @param {{ sink: (records: object[]) => unknown, maxRecords?: number }} options */
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

/*
  Sink for S3 or any S3-compatible store (R2's S3 API from Node). Pass your
  own client so core adds no dependency:
    import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
    s3Sink({ client: new S3Client({ region }), PutObjectCommand, bucket: 'my-audit', prefix: 'audit' })
*/
export function s3Sink({ client, PutObjectCommand, bucket, prefix = 'audit' } = {}) {
  if (!client || typeof PutObjectCommand !== 'function' || !bucket) {
    throw new Error('s3Sink needs { client, PutObjectCommand, bucket }');
  }
  return async (records) => {
    const key = `${prefix}/${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.jsonl`;
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: records.map((r) => JSON.stringify(r)).join('\n'),
        ContentType: 'application/x-ndjson'
      })
    );
  };
}

/* Audit fallback when no audit sink is configured: one JSON line per record. `fallback` tells status. */
export class ConsoleLogger {
  constructor({ write } = {}) {
    this.fallback = true;
    this.write = write || ((line) => console.info(line));
  }
  async log(entry) {
    this.write(JSON.stringify({ engine9_audit: true, ...logRecord(entry) }));
  }
  async flush() {}
}

/* No-op logger for tests / opt-out */
export class NullLogger {
  async log() {}
  async flush() {}
}

export default { JsonlFileLogger, BatchLogger, NullLogger, ConsoleLogger, r2Sink, s3Sink };
