# Deploy `@engine9/core` on a new website

engine9 is a set of standards for a people database and the endpoints that
read and write it, and libraries that implement those standards.
`@engine9/core` is the standalone library that creates that database and API:
standard tables (`person`, `person_email`, segments), a way to add people, and
optional login through an **identity provider**.

Use it as the site’s primary database, or with a database you already have.
`npx e9core setup --node` creates a SQLite file. `--db mysql://…` installs the
same standard tables into MySQL you already run. Cloudflare uses D1 as the
engine9 database. Your application database can stay beside it.

Local development does not need an identity provider. Production defaults to
[delegate](identityProviders/delegate.md).

Public libraries that share the standard:

| Library | Role |
| --- | --- |
| [`@engine9/interfaces`](https://github.com/engine9-io/interfaces) | Schemas and transforms core installs into the database |
| [`@engine9/id`](https://github.com/engine9-ai/id/blob/main/docs/deploy.md) | Browser library. Identity Tokens, and login against these endpoints |
| [`demo`](https://github.com/engine9-ai/demo) | Festival site (Astro + D1) using both |

The private **server** repository is for people who already have an
engine9-capable database. A new website uses `e9core`, from this package.

Most sites use **both** public pieces: id in the page, core for the database
and API.

## id vs core

|                  | **id**                                                  | **core**                                                              |
| ---------------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| Runs             | In the visitor’s browser                                | On your site (Node, or a Cloudflare Worker)                           |
| Stores data      | A token in the browser                                  | People, emails, segments in **your** database                         |
| Login            | Talks to the identity provider                          | Verifies the token that provider already issued                       |
| “Roles”          | **Declared roles**: show different copy. Easy to bypass | **Segment roles**: membership in the database. The API can return 403 |
| You need it when | You want Level 0 / Level 1 behavior on a page           | You want saved people, or pages that actually stay private            |

You can ship **id first** and add **core** later without renaming form fields.

## Automatic setup

You need Node.js 22+ and a Cloudflare account. Log in once:

```bash
npx wrangler login
```

Then, in an empty project folder:

```bash
npm install @engine9/core
npx e9core setup
```

That command does the file work for you:

- writes `wrangler.jsonc` (including the D1 database id Wrangler returns)
- creates the people tables and loads them into local D1
- creates API keys and writes them to `.env`

Do not hand-edit `wrangler.jsonc` or copy ids into it. Do not add `.dev.vars`. If that file exists, Wrangler prefers it and ignores `.env`.

Work on the HTML and CSS. When you want to try the API on your machine:

```bash
npx wrangler dev
```

When the same site should go on the internet:

```bash
npx e9core setup --remote
```

That loads the tables into production D1, copies the keys from `.env` into Cloudflare secrets, and deploys the Worker.

### Options most people use

| Command | What it does |
| --- | --- |
| `npx e9core setup` | Local database and `.env`. No public URL yet |
| `npx e9core setup --remote` | Production database, secrets, and deploy |
| `npx e9core setup --name festival` | Worker name. The database is still called `engine9` |
| `npx e9core setup --remote --domain www.example.com` | Also attaches that hostname |
| `npx e9core setup --node` | No Cloudflare. A SQLite file and `.env` only |

Run `setup` again anytime. It keeps the database and the keys you already have.
Every flag is also printed by `npx e9core setup --help`.

## Words used below

| Word               | Meaning                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **Site**           | Your public website origin, e.g. `https://www.example.com`                                                                       |
| **person_id**      | The number **your database** assigns (`person.id`). The identity provider does not assign it                                     |
| **Segment role**   | A segment UUID plus rules (`requiredAuth.minLevel`, scopes). Membership is a row in `person_segment`                             |
| **API key**        | A secret the caller sends. `e9key_…` stays on the server. `e9publickey_…` may be in the browser, and only has the `public` scope |
| **Identity provider** | Optional login service. Production defaults to delegate. Not required to store people locally                                 |
| **Core Session**   | Optional cookie your site sets after login, so later requests need not re-check the identity provider                           |
| **Identity Level** | Confidence (0–7), not permission. A role can _require_ a minimum level                                                           |

The CLI in this package is `e9core`. On a new website, run `e9core setup`.
The private server’s WorkerRunner is a different program, `e9`, and it expects
a database that is already engine9-capable.

## What gets set up

1. A SQLite database (on Cloudflare, that database is **D1**).
2. Standard tables and plugin rows.
3. Two API keys in `.env`: one private, one public.
4. A small HTTP API (`/api/people`, and later `/api/auth/login`) next to your site.
5. Optional, and not part of local setup: an identity provider so visitors can log in. Production defaults to delegate.

---

## Cloudflare and D1

`npx e9core setup` is this path. D1 is SQLite hosted by Cloudflare. The same
SQL runs on your machine and in production.

You do **not** need KV, R2, or Durable Objects for a working people API.

### Keys

`setup` writes `.env`. Node, Astro, and `wrangler dev` read it.

| Name in `.env` | What it is |
| --- | --- |
| `E9_ADMIN_API_KEY` | Full access. Server and scripts only. Never put this in page JavaScript |
| `E9_PUBLIC_API_KEY` | Signup forms. Safe to show to the browser |
| `SESSION_SECRET` | Signs the login cookie, if you turn login on later |

`npx e9core setup --remote` copies those three values to Cloudflare secrets.
To replace them: `npx e9core setup --rotate`, then `npx e9core setup --remote`.

`public` allows signup. It is not `admin`.

### Try a signup

With `npx wrangler dev` running, open `.env`, copy `E9_PUBLIC_API_KEY`, and:

```bash
curl -X POST http://localhost:8787/api/people \
  -H "Authorization: Bearer PASTE_E9_PUBLIC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"people":[{"given_name":"Alex","family_name":"Rivera","email":"alex@example.com","email_type":"Personal"}]}'
```

Field names are `given_name`, `family_name`, `email`, and `email_type`
(`Personal`, `Work`, or `Other`).

`GET /api/ok` needs no key.

### Login

Skip this while you are building the page. Saving people only needs the API key.

When visitors should log in, add an **identity provider**. Production defaults
to delegate. Steps are in
[identityProviders/delegate.md](identityProviders/delegate.md).

Segment roles are separate from the provider. A person only has a role after
a row exists in `person_segment`. Configuring a role does not grant it to
everyone.

---

## More control

Use these when the automatic command is not what you want. You still should
not paste ids into config files by hand; pass flags, or run the smaller
commands below.

| Flag | Effect |
| --- | --- |
| `--name <worker>` | Cloudflare Worker name. Default `my-site` |
| `--d1 <database>` | D1 name. Default `engine9` |
| `--domain <host>` | Adds a custom domain route, then use with `--remote` |
| `--no-deploy` | With `--remote`, update the database and secrets but do not deploy |
| `--refresh-schema` | Load tables again (only safe on an empty database) |
| `--rotate` | Replace the API keys in `.env` |
| `--db sqlite://./engine9.db` | SQLite file used before the data is copied to D1 |
| `--node` | Skip Wrangler. Tables and keys go to the SQLite file only |

Smaller commands, if you want to run one piece:

```bash
npx e9core installStandard --db sqlite://./engine9.db
npx e9core setup-keys
npx e9core setup-keys --remote
```

`installStandard` fills a database file on your computer. `setup` copies that
into D1. Tables without the plugin rows from `installStandard` will not
accept people writes.

The Worker that `setup` points at is
[`cloudflare/worker.js`](../cloudflare/worker.js). It reads `E9_PLUGIN_ID`
from the config `setup` wrote. Optional KV and R2 bindings are in
[`cloudflare/wrangler.toml.example`](../cloudflare/wrangler.toml.example).
Leave them out until you need them.

## Node (SQLite or MySQL)

Use this when the site is already a Node process, not a Worker.

```bash
npm install @engine9/core
npx e9core setup --node
```

If `knex` or `better-sqlite3` is not installed yet, that command installs them.

MySQL: `npx e9core setup --node --db mysql://user:pass@host/dbname`

Keys are in `.env`. Do not commit that file. Do not add `.dev.vars`.

Wire `createApi` into your HTTP app. A short sketch is in the
[core README quick start](../README.md#quick-start-node--sqlite--no-cloudflare).

---

## After it is up

| Task                | Call                                        |
| ------------------- | ------------------------------------------- |
| Health              | `GET /api/ok`                               |
| Signup              | `POST /api/people` with `{ people: [ … ] }` |
| Who is logged in    | `GET /api/auth/me` (after identity-provider login) |
| Change segment role | `POST /api/auth/role`                       |

Browser login steps: [with-core.md](https://github.com/engine9-ai/id/blob/main/docs/with-core.md).

Technical reference (KV caches, R2 logs, endpoint table):
[cloudflare/README.md](../cloudflare/README.md) and the
[core README](../README.md).
