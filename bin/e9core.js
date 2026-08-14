#!/usr/bin/env node
/*
  e9core -- Engine9 core command line.

    e9core create-api-key --db sqlite://./engine9.db --name "website" --scopes people:write,data:read,tasks:read,tasks:schedule [--default-role-id <segment-uuid>]
        Create an API key.  The plaintext key is printed once and only the
        hash is stored. --scopes is required (comma-separated). Use scope
        "admin" for full access. Optional --default-role-id sets the default role
        (segment UUID) when no role is specified on the request.

    e9core create-api-key --print-sql --name "website" --scopes ... [--default-role-id <uuid>]
        No database: generate a key and print the INSERT statement for the
        api_key table -- useful for D1 migration files (wrangler d1 execute).

    e9core sqlite-ddl [--schema @engine9/interfaces/person] [--stack ...]
        Print the SQLite/D1 create statements for a schema (default stack
        includes when omitted) -- useful for D1 migration files.

  Schema deploy, plugin install, and live diff live on @engine9/server
  (PluginWorker / SchemaWorker). This CLI does not mutate interface tables.

  --db may be omitted when ENGINE9_DATABASE_CONNECTION is set.
*/
import SQLWorker from '../lib/SQLWorker.js';
import { SCHEMAS } from '../lib/schemas.js';
import { loadPluginMetadata, DEFAULT_STACK_PATH } from '../lib/stackMetadata.js';
import {
  SqlApiKeyStore, generateApiKey, hashApiKey,
  assertValidKeyScopes,
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
  return new SQLWorker({ accountId: args.account || 'client', auth: { database_connection: db } });
}

async function standardPluginPaths(args) {
  if (args.schema) return [args.schema];
  const metadata = await loadPluginMetadata(args.stack || DEFAULT_STACK_PATH);
  return metadata.include;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  switch (command) {
    case 'create-api-key': {
      if (!args.scopes || args.scopes === true) {
        console.error('create-api-key requires --scopes <list>');
        console.error('  Examples: --scopes tasks:read,tasks:schedule');
        console.error('            --scopes admin');
        process.exit(1);
      }
      let scopes;
      try {
        scopes = assertValidKeyScopes(String(args.scopes).split(','));
      } catch (e) {
        console.error(e.message);
        process.exit(1);
      }
      const defaultRoleId = args['default-role-id'] || null;
      if (args['print-sql']) {
        const key = generateApiKey({ scopes });
        const id = crypto.randomUUID();
        console.error('API key created (store this now -- it cannot be recovered):');
        console.error(JSON.stringify({ id, name: args.name || '', scopes, default_role_id: defaultRoleId, key }, null, 2));
        const esc = (s) => String(s).replaceAll("'", "''");
        const roleSql = defaultRoleId ? `'${esc(defaultRoleId)}'` : 'NULL';
        console.log(`INSERT INTO api_key (id, name, key_hash, scopes, default_role_id, active) VALUES ('${id}', '${esc(args.name || '')}', '${hashApiKey(key)}', '${esc(JSON.stringify(scopes))}', ${roleSql}, 1);`);
        break;
      }
      const worker = getWorker(args);
      try {
        const store = new SqlApiKeyStore({ worker });
        await store.deploy();
        const created = await store.create({
          name: args.name || '',
          scopes,
          defaultRoleId
        });
        console.log('API key created (store this now -- it cannot be recovered):');
        console.log(JSON.stringify(created, null, 2));
      } finally {
        await worker.destroy();
      }
      break;
    }
    case 'sqlite-ddl': {
      // No database required: print DDL from the static schema registry
      const names = await standardPluginPaths(args);
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
      console.log('Usage: e9core <create-api-key|sqlite-ddl> [--db <connection>] [options]');
      process.exit(command ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
