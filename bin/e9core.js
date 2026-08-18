#!/usr/bin/env node
/*
  e9core -- Engine9 core command line.

    e9core create-api-key --db sqlite://./engine9.db --name "website" --scopes people:write,data:read,tasks:read,tasks:schedule [--default-role-id <segment-uuid>]
        Core-only wrapper around SQLWorker.createApiKey (no accounts.d).
        The plaintext key is printed once and only the hash is stored.
        --scopes is required (comma-separated). Use scope "admin" for full
        access. Optional --default-role-id sets the default role (segment UUID).
        On an Engine9 server account use:
          e9 sqlworker createApiKey -a <account_id> --name … --scopes …

    e9core create-api-key --print-sql --name "website" --scopes ... [--default-role-id <uuid>]
        No database: generate a key and print the INSERT statement for the
        api_key table -- useful for D1 migration files (wrangler d1 execute).

    e9core sqlite-ddl --schema @engine9/interfaces/person
        Print the SQLite/D1 create statements for a schema -- useful for D1
        migration files.

    e9core install-standard --db sqlite://./engine9.db [--stack ...]
        Live-install a stack (default @engine9/interfaces/stacks/standard)
        into the database: plugin rows + create/alter tables.

  --db may be omitted when ENGINE9_DATABASE_CONNECTION is set.
*/
import PluginWorker from '../lib/PluginWorker.js';
import {
  generateApiKey, hashApiKey,
  assertValidKeyScopes,
} from '../auth/index.js';
import { buildCreateTable } from '../lib/sql/sqliteDDL.js';
import { standardizeSchema } from '../lib/sql/standardizeSchema.js';
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

function getPluginWorker(args) {
  const db = args.db || process.env.ENGINE9_DATABASE_CONNECTION;
  if (!db) {
    console.error('Provide --db <connection> or set ENGINE9_DATABASE_CONNECTION');
    process.exit(1);
  }
  return new PluginWorker({
    accountId: args.account || 'client',
    auth: { database_connection: db },
    defaultStackPath: args.stack || undefined
  });
}

async function loadSchemaModule(name) {
  if (typeof name === 'object') return name;
  const schemaMod = await import(`${name}/schema.js`);
  return schemaMod.default;
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
      const worker = getPluginWorker(args);
      try {
        const created = await worker.createApiKey({
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
      if (args.stack) {
        console.error('sqlite-ddl does not accept --stack; pass --schema <package>');
        console.error('  Example: e9core sqlite-ddl --schema @engine9/interfaces/person');
        process.exit(1);
      }
      if (!args.schema || args.schema === true) {
        console.error('sqlite-ddl requires --schema <package>');
        console.error('  Example: e9core sqlite-ddl --schema @engine9/interfaces/person');
        process.exit(1);
      }
      const schema = await loadSchemaModule(args.schema);
      if (!schema) {
        console.error(`Unknown schema ${args.schema}`);
        process.exit(1);
      }
      const standard = standardizeSchema(schema, sqliteDialect);
      console.log(`-- ${args.schema}`);
      for (const table of standard.tables || []) {
        if (table.type === 'view') continue;
        const { statements } = buildCreateTable({
          table: table.name,
          columns: table.columns,
          indexes: table.indexes || []
        });
        statements.forEach((s) => console.log(`${s};`));
      }
      break;
    }
    case 'install-standard': {
      const worker = getPluginWorker(args);
      try {
        const result = await worker.installStandard({ path: args.stack || args.path });
        console.log(JSON.stringify(result, null, 2));
      } finally {
        await worker.destroy();
      }
      break;
    }
    default:
      console.log('Usage: e9core <create-api-key|sqlite-ddl|install-standard> [--db <connection>] [options]');
      process.exit(command ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
