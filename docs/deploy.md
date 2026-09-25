# Deploy `@engine9/core` on a website

**engine9** is a set of standards for a people database and the endpoints that
read and write it, and libraries that implement those standards.
`@engine9/core` creates that database and HTTP API for your site: standard
tables (`person`, `person_email`, segments), a way to add people, and optional
login through an **identity provider**.

If your site today is only HTML and CSS, you are not adding a mysterious second
“Node host.” You are choosing how the **website** and **engine9** relate:

1. **Content and engine9 on the same platform (recommended)** — one website.
   Pages and `/api` share one origin. A server that used to only serve HTML
   becomes a **Node.js** (or Cloudflare) process that serves the pages **and**
   the engine9 API.
2. **Content and engine9 independently (advanced)** — HTML stays on one host;
   the API runs elsewhere. The page points at the API with `ENGINE9_API`, and
   you allow that page’s origin for CORS.

API keys are created by `npx e9core setup` (or `setup --node`). You do not
generate them by hand for a normal install.

Local development does not need an identity provider. Production defaults to
[delegate](identityProviders/delegate.md).

Public libraries that share the standard:

| Library | Role |
| --- | --- |
| [`@engine9/interfaces`](https://github.com/engine9-io/interfaces) | Schemas and transforms. Install this beside core; see [Interfaces](#interfaces) |
| [`@engine9/id`](https://github.com/engine9-ai/id/blob/main/docs/deploy.md) | Browser library. Identity Tokens, and login against these endpoints |
| [`demo-festival`](https://github.com/engine9-ai/demo-festival) | Festival site (Astro + D1) using both |

The private **server** repository is for people who already have an
engine9-capable database. A new website uses `e9core`, from this package.

## Interfaces

`@engine9/interfaces` is a separate package. Install it in the same project
as `@engine9/core`. Core lists it as a peer, so the site chooses the
interfaces version and upgrades it on its own schedule.

```bash
npm install @engine9/core @engine9/interfaces
```

`installStandard` and `e9core sqlite-ddl` read the interfaces package that
this install resolved. When you upgrade interfaces, install the new version,
rebuild the plugin registry, and redeploy:

```bash
npm install @engine9/interfaces@latest
npx e9core build-plugins
```

`build-plugins` writes `engine9.plugins.js` from the interfaces package in
this project. The Worker and the CLI load that registry. Ship the new file
with the deploy. Leave the `@engine9/core` version as it is when only
interfaces changed.

## The project database

The database you deploy here is the **primary database for the project**.
Setup writes the engine9 tables into that one SQLite file, D1 database, or
MySQL database. The site's other code uses the same database. An Astro site,
a Next.js app, or another schema adds its tables there when those names do
not collide with engine9 tables.

**Table names are immutable. The names are the engine9 standard.**
`person`, `person_email`, `segment`, `timeline`, `transaction`, and the rest
of the tables from
[`@engine9/interfaces`](https://github.com/engine9-io/interfaces) stay under
those names. `person` stays `person`. Columns on those tables stay as
published. Other engine9 libraries join on these names. A project-local table
uses a different name from every published engine9 table (`person`, `event`,
`message`, `transaction`, `segment`, `plugin`, `timeline`, `input`, `api_key`,
and the rest of that catalog).

### Choosing a table

Before creating a table, decide in this order:

1. **Use a published interface.** Look through `@engine9/interfaces` for a
   schema that already describes the thing. An event is
   `@engine9/interfaces/event`: tables `event` and `person_event`. That
   package is not in the default stack, so install it when the project needs
   events (`npx e9core sqlite-ddl --schema @engine9/interfaces/event`, or add
   the package to the stack). Keep those table names. The Worker runs only
   the plugins compiled into it; every `@engine9/interfaces` plugin is
   included unless the site narrows the set with `npx e9core build-plugins`
   ([details](../README.md#plugins-are-compiled-into-the-build)).
2. **Build an engine9 package when the feature is a primary extension of
   engine9.** If no interface matches, and other engine9 projects should share
   the same contract, publish it. A shared schema is an interface
   (`@engine9/interfaces/<name>`). A deployable integration — workers, inbound
   transforms, a vendor — is a plugin (`@engine9/plugins/<name>`). The table
   names you publish there join the standard and stay fixed.
3. **Prefix tables that belong only to this project.** A blog, a CMS, or
   another local feature gets tables named for that use case: `content_blog`,
   `cms_post`, `cms_page`. Those tables live in this same database. The
   prefix keeps them clear of the engine9 catalog.

The same rule is in the [core README](../README.md#the-project-database).

## Words used here

| Word | Meaning |
| --- | --- |
| **engine9** | The product and standard (tables, fields, pipeline, scopes) — always written lowercase |
| **Same platform** | HTML/CSS and the engine9 API are one website / one origin |
| **Independent hosts** | HTML on one host, API on another, linked by page constants + CORS |
| **Domain** | Host or `host:port` for JWT `aud`, e.g. `www.example.com` (not a full `https://` origin) |
| **person_id** | The number **your database** assigns (`person.id`) |
| **API key** | Secret the caller sends. `e9key_…` stays on the server. `e9publickey_…` may be in the browser (`public` scope only) |
| **Setup wizard** | Local HTML at `/setup` on `e9core serve`. Not part of the production site |
| **Identity provider** | Optional login service. Production defaults to delegate |
| **Core Session** | Optional cookie your site sets after login |
| **Identity Level** | Confidence (0–7), not permission |

The CLI is `e9core`. The private server’s program is `e9` (different tool).

## id vs core

|                  | **id**                                                  | **core**                                                              |
| ---------------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| Runs             | In the visitor’s browser                                | On your site (same platform) or as a separate API (advanced)          |
| Stores data      | A token in the browser                                  | People, emails, segments in **your** database                         |
| Login            | Talks to the identity provider                          | Verifies the token that provider already issued                       |
| “Roles”          | **Declared roles**: show different copy. Easy to bypass | **Segment roles**: membership in the database. The API can return 403 |
| You need it when | You want Level 0 / Level 1 behavior on a page           | You want saved people, or pages that actually stay private            |

You can ship **id first** and add **core** later without renaming form fields.

---

## 1. Content and engine9 on the same platform (recommended)

One process serves your pages and the engine9 API. Signup forms call `/api/people`
on the **same origin**. You do not set a separate browser “environment variable”
for the API URL. After setup, open the printed **setup page** and copy the
same-platform snippet (relative `/api` + public key).

### Cloudflare (local, then production)

You need Node.js 18+ and a Cloudflare account. Log in once:

```bash
npx wrangler login
```

In the project folder:

```bash
npm install @engine9/core @engine9/interfaces
npx e9core setup
```

That command:

- writes `wrangler.jsonc` (including the D1 database id)
- creates the people tables in local D1
- creates API keys **and** `E9_SETUP_TOKEN`, writes them to `.env`

Do not hand-edit `wrangler.jsonc` or copy ids into it. Do not add `.dev.vars`.
If that file exists, Wrangler prefers it and ignores `.env`.

Try it on your machine. The wizard runs locally and is not part of the deployed Worker:

```bash
npx e9core serve
```

Choose **Cloudflare** when that is where the production site will run. The wizard itself stays on this development machine: it checks the Cloudflare login here, creates the local project, starts a local preview, and can deploy production. The address it prints looks like `http://127.0.0.1:8787/setup?token=…`.

To deploy production, use **Deploy the production site to Cloudflare** in the wizard, or:

```bash
npx e9core setup --remote
```

That loads production D1, copies secrets from `.env` into Cloudflare, and
deploys the Worker. Attach a hostname with `--domain www.example.com`.

### Your own servers (Node.js)

If the site is (or should become) a Node process that serves HTML and the API:

```bash
npm install @engine9/core @engine9/interfaces
npx e9core setup --node
npx e9core serve
```

`setup --node` creates `engine9.db` and `.env` (keys included).
`serve` is the same-platform local website: static files from `./public` (or
safe files in the project folder) **and** `/api` on one port. It prints the
setup URL. Put `index.html` in `./public` (or the project root) so the form and
API share one origin.

MySQL instead of SQLite:

```bash
npx e9core setup --node --db mysql://user:pass@host/dbname
```

For production on your own host, run the same Node app (or mount `createApi` in
Express/Astro/etc. as in the [README quick start](../README.md#install-on-your-own-server-nodejs)).
Keep `.env` off git.

---

## 2. Content and engine9 independently (advanced)

Use this only when the HTML host cannot run the API (static CDN, separate
artifact preview, etc.).

1. Stand up engine9 with Cloudflare (`e9core setup` + `wrangler dev` / `--remote`)
   or Node (`e9core setup --node` + `e9core serve --api-only`).
2. Open the local wizard (`npx e9core serve`) and answer where the **production** site will run: Cloudflare or your own servers. Independent hosts is under Advanced.
3. Copy the **independent hosts** snippet into the page:
   - `ENGINE9_API` — full URL of the API (whatever host and port is actually
     running; any port is fine if this matches). This is a **constant in your
     HTML/JS**, not a server environment variable you export in a shell.
   - `ENGINE9_PUBLIC_KEY` — the public key from setup (`e9publickey_…`)
   - `ENGINE9_SOURCE` — optional tag for signups
4. On the setup page, save the **content site’s origin** (scheme + host + port)
   so the browser may call the API (CORS). Example:
   `http://localhost:8768` or `https://www.example.com`.
5. Finish setup so the page stops showing the public key.

Never put `E9_ADMIN_API_KEY` (`e9key_…`) in page JavaScript.

---

## API keys (created by setup)

`npx e9core setup` and `setup --node` write `.env`. You normally do not run a
separate key command.

| Name in `.env` | What it is |
| --- | --- |
| `E9_ADMIN_API_KEY` | Full access. Server and scripts only. Never put this in page JavaScript |
| `E9_PUBLIC_API_KEY` | Signup forms. Safe to show to the browser (`e9publickey_…`) |
| `SESSION_SECRET` | HMAC key for a Core Session after login |
| `E9_SETUP_TOKEN` | Opens the local `/setup` wizard until you finish. Not used by the production Worker |
| `E9_ALLOWED_ORIGINS` | Optional comma-separated origins (independent hosts); setup page can also store origins in the database |

`npx e9core setup --remote` copies these to Cloudflare secrets.
To replace them: `npx e9core setup --rotate`, then `setup --remote` again.

`public` allows signup. It is not `admin`.

### Options most people use

| Command | What it does |
| --- | --- |
| `npx e9core setup` | Local Cloudflare database and `.env` |
| `npx e9core setup --remote` | Production D1, secrets, and deploy |
| `npx e9core setup --node` | SQLite (or MySQL) + `.env`; then `e9core serve` |
| `npx e9core serve` | Same-platform local site (HTML + `/api`) |
| `npx e9core setup --name festival` | Worker name. The database is still called `engine9` |
| `npx e9core setup --remote --domain www.example.com` | Also attaches that hostname |

Run `setup` again anytime. It keeps the database and the keys you already have.
Every flag is also printed by `npx e9core setup --help`.

### Try a signup (same platform)

With the API running, prefer the wizard at `/setup`. Example with curl:

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
to delegate, and the server side is already done: the Worker and `e9core serve`
turn on `/api/auth/*` because setup wrote `SESSION_SECRET`. What remains is
allowing your Domain on delegate and adding `@engine9/id` to the page. Steps
are in [identityProviders/delegate.md](identityProviders/delegate.md) and the
[README](../README.md#add-login).

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
| `--rotate` | Replace the API keys and setup token in `.env` |
| `--db sqlite://./engine9.db` | SQLite file used before the data is copied to D1 |
| `--node` | Skip Wrangler. Tables and keys go to the SQLite file only |

```bash
npx e9core installStandard --db sqlite://./engine9.db
npx e9core setup-keys
npx e9core setup-keys --remote
npx e9core create-api-key --db sqlite://./engine9.db --name website --scopes public
```

`installStandard` fills a database file on your computer. `setup` copies that
into D1. Tables without the plugin rows from `installStandard` will not
accept people writes.

The Worker that `setup` points at is
[`cloudflare/worker.js`](../cloudflare/worker.js). Optional KV and R2 bindings
are in [`cloudflare/wrangler.toml.example`](../cloudflare/wrangler.toml.example).

Wire `createApi` into your HTTP app. A short sketch is in the
[core README quick start](../README.md#install-on-your-own-server-nodejs).

---

## After it is up

| Task                | Call                                        |
| ------------------- | ------------------------------------------- |
| Health              | `GET /api/ok`                               |
| Setup wizard (local) | `GET /setup?token=…` on `e9core serve` only |
| Signup              | `POST /api/people` with `{ people: [ … ] }` |
| Who is logged in    | `GET /api/auth/me` (after identity-provider login) |
| Change segment role | `POST /api/auth/role`                       |

Browser login steps: [with-core.md](https://github.com/engine9-ai/id/blob/main/docs/with-core.md).

Technical reference (KV caches, R2 logs, endpoint table):
[cloudflare/README.md](../cloudflare/README.md) and the
[core README](../README.md).
