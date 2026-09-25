#!/usr/bin/env node
/*
  @engine9/core bin.e9core → bin/e9core.js

  Core-only helpers against a database connection (--db / ENGINE9_DATABASE_CONNECTION).
  No accounts.d, no WorkerRunner.

  This is not the server CLI. @engine9/server publishes bin.e9, which points at
  server/bin/e9 (WorkerRunner: `e9 personworker installStandard -a …`).
  See core/README.md "The e9core CLI" and server/README.md.

    e9core create-api-key --db sqlite://./engine9.db --name "website" --scopes people:write,data:read,tasks:read,tasks:schedule [--default-role-id <segment-uuid>]
        Core-only wrapper around SQLWorker.createApiKey.
        The plaintext key is printed once and only the hash is stored.
        --scopes is required (comma-separated). Use scope "admin" for full
        access. Optional --default-role-id sets the default role (segment UUID).
        On an Engine9 server account use:
          e9 sqlworker createApiKey -a <account_id> --name … --scopes …

    e9core setup [--name my-site] [--remote] [--domain example.com] [--node]
        Writes wrangler.jsonc (Cloudflare path), the engine9 database, and .env
        (API keys, SESSION_SECRET, E9_SETUP_TOKEN). Keys are part of setup.
        --remote also loads production D1, saves Cloudflare secrets, and deploys.
        --node skips Cloudflare (SQLite + .env); then use: e9core serve
        Do not add .dev.vars (Wrangler prefers it over .env).

    e9core serve [--port 8787] [--host 127.0.0.1] [--setup] [--db sqlite://./engine9.db] [--api-only]
        Local website plus the setup wizard at /setup. Listens on 127.0.0.1.
        --setup reopens the wizard after it has been finished.

    e9core setup-keys [--d1 engine9] [--remote] [--rotate]
        Create/reuse site keys and E9_SETUP_TOKEN (normally done by setup).
        Writes plaintext to .env only (gitignored). Do not add .dev.vars;
        Wrangler prefers that file and ignores the same names in .env.
        Stores only hashes in local D1. --remote also stores hashes in
        production D1 and saves the values as Cloudflare secrets.

    e9core create-api-key --print-sql --name "website" --scopes ... [--default-role-id <uuid>]
        No database: generate a key and print the INSERT statement for the
        api_key table -- useful for D1 migration files (wrangler d1 execute).

    e9core sqlite-ddl --schema @engine9/interfaces/person
        Print the SQLite/D1 create statements for a schema -- useful for D1
        migration files.

    e9core installStandard --db sqlite://./engine9.db [--stack ...]
        Live-install published person interfaces (default), or an opt-in stack
        with --stack (e.g. @engine9/interfaces/stacks/standard): plugin rows +
        create/alter tables.

    e9core build-plugins [--out engine9.plugins.js] [--plugins a,b] [--packages a,b] [--check]
        Write the plugin registry module the Worker (or server) is built with.
        Reads "engine9.plugins" / "engine9.pluginPackages" from package.json.
        --check exits non-zero when the file is out of date (for CI).

  --db may be omitted when ENGINE9_DATABASE_CONNECTION is set.

  These commands use every interface in @engine9/interfaces. Plugins outside
  that package run only in a build that includes them (build-plugins).
*/
import PluginWorker from '../lib/PluginWorker.js';
import { loadRegistrySchema, setDefaultPluginRegistry } from '../lib/pluginRegistry.js';
import interfacePlugins from '../lib/plugins/interfaces.js';
import { buildPlugins } from './buildPlugins.js';
import {
  generateApiKey, hashApiKey,
  assertValidKeyScopes,
} from '../auth/index.js';
import { buildCreateTable } from '../lib/sql/sqliteDDL.js';
import { standardizeSchema } from '../lib/sql/standardizeSchema.js';
import sqliteDialect from '../lib/sql/dialects/SQLite.js';
import { setupKeys, readEnvValue } from './setupKeys.js';
import { SETUP_HELP, setup } from './setup.js';
import { serve, parseServeArgs } from './serve.js';
import { runSetupStep } from './setupFlow.js';
import { SETUP_STEPS } from '../api/setupSteps.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

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

function listArg(value) {
  if (!value || value === true) return undefined;
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const plugins = setDefaultPluginRegistry(interfacePlugins);
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  switch (command) {
    case 'setup': {
      if (args.help) {
        console.log(SETUP_HELP);
        console.log('');
        console.log('Wizard steps (same questions as /setup). Pass one answer at a time:');
        for (const step of SETUP_STEPS) {
          const when = step.when ? ` [${step.when}]` : '';
          console.log(`  --step ${step.id}${when}`);
          console.log(`    ${step.prompt}`);
        }
        break;
      }
      if (args.step && args.step !== true) {
        const result = await runSetupStep({
          action: String(args.step),
          host: args.host && args.host !== true ? String(args.host) : undefined,
          domain: args.domain && args.domain !== true ? String(args.domain) : undefined,
          origins: args.origins && args.origins !== true ? String(args.origins) : undefined,
          email: args.email && args.email !== true ? String(args.email) : undefined,
          givenName: args['given-name'] && args['given-name'] !== true ? String(args['given-name']) : undefined
        }, {
          cwd: process.cwd(),
          db: args.db && args.db !== true ? String(args.db) : undefined
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      if (args.host && args.host !== true) {
        const host = String(args.host);
        await runSetupStep({ action: 'choose', host }, { cwd: process.cwd() });
        if (host === 'node') args.node = true;
      }
      const result = await setup({
        cwd: process.cwd(),
        name: args.name && args.name !== true ? String(args.name) : undefined,
        d1: args.d1 && args.d1 !== true ? String(args.d1) : undefined,
        db: args.db && args.db !== true ? String(args.db) : undefined,
        domain: args.domain && args.domain !== true ? String(args.domain) : undefined,
        remote: args.remote === true,
        deploy: args['no-deploy'] ? false : undefined,
        node: args.node === true,
        rotate: args.rotate === true,
        refreshSchema: args['refresh-schema'] === true
      });
      for (const note of result.notes) console.log(note);
      const envPath = path.join(process.cwd(), '.env');
      const setupToken = existsSync(envPath)
        ? readEnvValue(readFileSync(envPath, 'utf8'), 'E9_SETUP_TOKEN')
        : '';
      if (args.node) {
        console.log('Local Node setup is done. Start the same-platform site with:');
        console.log('  npx e9core serve');
        if (setupToken) {
          console.log(`Then open the wizard printed by: npx e9core serve`);
        }
      } else if (!args.remote) {
        console.log('Local Cloudflare setup is done. Open the wizard with:');
        console.log('  npx e9core serve');
        console.log('Choose Cloudflare there to preview and deploy.');
      }
      break;
    }
    case 'serve': {
      const serveArgs = parseServeArgs(process.argv.slice(3));
      const result = await serve({
        cwd: process.cwd(),
        port: serveArgs.port && serveArgs.port !== true ? Number(serveArgs.port) : undefined,
        host: serveArgs.host && serveArgs.host !== true ? String(serveArgs.host) : undefined,
        db: serveArgs.db && serveArgs.db !== true ? String(serveArgs.db) : undefined,
        apiOnly: serveArgs['api-only'] === true,
        reopenSetup: serveArgs.setup === true,
        staticRoot: serveArgs.root && serveArgs.root !== true ? String(serveArgs.root) : undefined
      });
      for (const note of result.notes) console.log(note);
      break;
    }
    case 'setup-keys': {
      const worker = args.db ? getPluginWorker(args) : null;
      try {
        const result = await setupKeys({
          cwd: process.cwd(),
          d1: args.d1 && args.d1 !== true ? String(args.d1) : 'engine9',
          remote: args.remote === true,
          rotate: args.rotate === true,
          applySql: worker
            ? async (sql) => {
              await worker.query({ sql });
            }
            : undefined
        });
        if (result.reused) {
          console.log('Keys already in .env. Pass --rotate to replace them.');
        } else {
          console.log('Saved keys in .env (not committed). Do not add .dev.vars.');
          if (result.created.admin) console.log('  E9_ADMIN_API_KEY — server only');
          if (result.created.public) console.log('  E9_PUBLIC_API_KEY — signup forms / browser');
          if (result.created.session) console.log('  SESSION_SECRET — signs the login cookie');
          if (result.created.setupToken) console.log('  E9_SETUP_TOKEN — local wizard only');
        }
        for (const note of result.notes) console.log(note);
        if (!args.remote) {
          console.log('When you deploy: npx e9core setup-keys --remote');
        }
      } finally {
        if (worker) await worker.destroy();
      }
      break;
    }
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
      let schema;
      try {
        schema = await loadRegistrySchema(plugins, String(args.schema));
      } catch (e) {
        console.error(e.message);
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
    case 'installStandard': {
      const worker = getPluginWorker(args);
      try {
        const result = await worker.installStandard({ path: args.stack || args.path });
        console.log(JSON.stringify(result, null, 2));
      } finally {
        await worker.destroy();
      }
      break;
    }
    case 'build-plugins': {
      const result = buildPlugins({
        cwd: process.cwd(),
        out: args.out && args.out !== true ? String(args.out) : undefined,
        plugins: listArg(args.plugins),
        packages: listArg(args.packages),
        check: args.check === true
      });
      const rel = path.relative(process.cwd(), result.out);
      if (args.check) console.log(`${rel} is current (${result.count} plugins).`);
      else console.log(`${result.changed ? 'Wrote' : 'Unchanged'} ${rel} (${result.count} plugins).`);
      break;
    }
    default:
      if (!command || args.help) console.log(SETUP_HELP);
      console.log('Other commands: e9core <serve|setup-keys|create-api-key|sqlite-ddl|installStandard|build-plugins>');
      console.log('Flags for setup: npx e9core setup --help');
      process.exit(command ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
