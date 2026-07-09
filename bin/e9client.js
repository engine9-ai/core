#!/usr/bin/env node
/*
  e9client -- Engine9 client command line.

    e9client install --db sqlite://./engine9.db
        Create/update the Engine9 database from scratch: all standard
        interface schemas plus the api_key table.

    e9client create-api-key --db sqlite://./engine9.db --name "website" [--scopes people:write,data:read]
        Create an API key.  The plaintext key is printed once and only the
        hash is stored.

    e9client create-api-key --print-sql --name "website" [--scopes ...]
        No database: generate a key and print the INSERT statement for the
        api_key table -- useful for D1 migration files (wrangler d1 execute).

    e9client diff --db sqlite://./engine9.db [--schema @engine9/interfaces/person]
        Show schema differences without applying them.

    e9client sqlite-ddl [--schema @engine9/interfaces/person]
        Print the SQLite/D1 create statements for a schema (all standard
        schemas when omitted) -- useful for D1 migration files.

  --db may be omitted when ENGINE9_DATABASE_CONNECTION is set.
*/
import SchemaWorker from '../lib/SchemaWorker.js';
import { STANDARD_INSTALL_SCHEMAS, SCHEMAS } from '../lib/schemas.js';
import {
  SqlApiKeyStore, API_KEY_SCHEMA, generateApiKey, hashApiKey,
} from '../auth/index.js';
import { buildCreateTable } from '../lib/sql/sqliteDDL.js';
import sqliteDialect from '../lib/sql/dialects/SQLite.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.indexOf('--') === 0) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.indexOf('--') === 0) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    } else args._.push(a);
  }
  return args;
}

function getWorker(args) {
  const db = args.db || process.env.ENGINE9_DATABASE_CONNECTION;
  if (!db) {
    console.error('Provide --db <connection> or set ENGINE9_DATABASE_CONNECTION');
    process.exit(1);
  }
  return new SchemaWorker({ accountId: args.account || 'client', auth: { database_connection: db } });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  switch (command) {
    case 'install': {
      const worker = getWorker(args);
      try {
        const r = await worker.installStandard();
        await worker.deploy({ schema: API_KEY_SCHEMA });
        console.log(JSON.stringify(r, null, 2));
      } finally {
        await worker.destroy();
      }
      break;
    }
    case 'create-api-key': {
      if (args['print-sql']) {
        const scopes = args.scopes ? String(args.scopes).split(',').map((s) => s.trim()) : [];
        const key = generateApiKey();
        const id = crypto.randomUUID();
        console.error('API key created (store this now -- it cannot be recovered):');
        console.error(JSON.stringify({ id, name: args.name || '', scopes, key }, null, 2));
        const esc = (s) => String(s).replaceAll("'", "''");
        console.log(`INSERT INTO api_key (id, name, key_hash, scopes, active) VALUES ('${id}', '${esc(args.name || '')}', '${hashApiKey(key)}', '${esc(JSON.stringify(scopes))}', 1);`);
        break;
      }
      const worker = getWorker(args);
      try {
        const store = new SqlApiKeyStore({ worker });
        await store.deploy();
        const scopes = args.scopes ? String(args.scopes).split(',').map((s) => s.trim()) : [];
        const { key, id, name } = await store.create({ name: args.name || '', scopes });
        console.log('API key created (store this now -- it cannot be recovered):');
        console.log(JSON.stringify({ id, name, scopes, key }, null, 2));
      } finally {
        await worker.destroy();
      }
      break;
    }
    case 'diff': {
      const worker = getWorker(args);
      try {
        const schemas = args.schema ? [args.schema] : STANDARD_INSTALL_SCHEMAS;
        for (const schema of schemas) {
          const d = await worker.diff({ schema });
          if (d.tables.length > 0) console.log(schema, JSON.stringify(d, null, 2));
          else console.log(schema, 'no differences');
        }
      } finally {
        await worker.destroy();
      }
      break;
    }
    case 'sqlite-ddl': {
      // No database required: print DDL from the static schema registry
      const names = args.schema ? [args.schema] : STANDARD_INSTALL_SCHEMAS;
      const defaultStandardColumn = { name: '', type: '', length: null, nullable: true, auto_increment: false };
      for (const name of names) {
        const schema = typeof name === 'object' ? name : SCHEMAS[name];
        if (!schema) {
          console.error(`Unknown schema ${name}`);
          process.exit(1);
        }
        console.log(`-- ${name}`);
        for (const table of schema.tables || []) {
          if (table.type === 'view') continue;
          const columns = Object.entries(table.columns || {}).map(([key, c]) => {
            const col = typeof c === 'string' ? { type: c } : c;
            const typeDetails = sqliteDialect.getType(col.type) || {};
            return { ...defaultStandardColumn, ...typeDetails, ...col, name: key };
          });
          const { statements } = buildCreateTable({ table: table.name, columns, indexes: table.indexes || [] });
          statements.forEach((s) => console.log(`${s};`));
        }
      }
      break;
    }
    default:
      console.log('Usage: e9client <install|create-api-key|diff|sqlite-ddl> [--db <connection>] [options]');
      process.exit(command ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
