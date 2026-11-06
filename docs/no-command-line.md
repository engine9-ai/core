# Run a site with no command line

This page is for a site whose owner works only in the GitHub and Cloudflare
web pages, and for an AI agent working in a hosted session with no Cloudflare
login. Neither has a terminal that keeps files between runs. In that setup
the only place a command runs is CI. Here that is a GitHub Actions workflow.

The setup commands are the same ones a laptop uses. `npx e9core setup
--remote` reads what production already has, meaning the D1 tables and the
Worker's secrets. It creates only what is missing. A second run, on a fresh
runner, changes nothing. Nobody copies a key or a secret by hand.

## What the owner sets

Three repository secrets (GitHub: **Settings**, **Secrets and variables**,
**Actions**, **New repository secret**):

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | A Cloudflare API token (Cloudflare dashboard: **My Profile**, **API Tokens**, **Create Token**). Start from the **Edit Cloudflare Workers** template, add **Account**, **D1**, **Edit**, and limit it to the one account |
| `CLOUDFLARE_ACCOUNT_ID` | The account that owns the Worker and its D1 database (Cloudflare dashboard: **Workers & Pages**, right-hand column) |
| `E9_SUPERADMINS` | Comma-separated emails that act as this site's admin, such as `owner@example.com`. Each must be a named person's address. Optional when the site already has admins in its database |

If `wrangler.jsonc` has no single custom-domain route, also add a repository
**variable**, `SITE_URL` (`https://www.example.com`), so the upgrade step
can reach the site.

That is all. The API keys, `SESSION_SECRET`, and `AGENT_CREDENTIALS_SECRET`
are made by the workflow and stored as Worker secrets. Never choose one
yourself, and never paste one into a GitHub secret.

## The workflow

Copy [`cloudflare/github-deploy.yml.example`](../cloudflare/github-deploy.yml.example)
to `.github/workflows/deploy.yml` (GitHub can create the file in the browser:
**Add file**, **Create new file**). On every push to `main` it runs:

1. `npx e9core setup --remote --no-deploy`. It creates the D1 database and
   loads its tables when they are missing. It adds the API keys and signing
   secrets the Worker does not have yet. It never replaces one that exists.
2. `npx wrangler deploy`, with `E9_SUPERADMINS` from the repository secret.
3. `npx e9core upgrade --remote`. It upgrades the database to the code just
   deployed ([upgrading.md](upgrading.md)). `--remote` writes an admin key to
   D1 that expires after 15 minutes and is deleted when the step ends. No
   admin key is stored anywhere for this.

A deploy never changes the database by itself. Step 3 does that, every time.

Run by hand (**Actions**, **Deploy**, **Run workflow**), it takes three
inputs:

| Input | Use |
| --- | --- |
| `command` | `upgrade` (default), or `installDefaultPlugins` when the status page asks for it |
| `options` | Extra flags for that command: `--dry-run`, `--plugin <path>`, or an opt-in upgrade such as `--drop-name-columns` |
| `rotate` | Replace production's API keys and signing secrets. Everyone signed in signs in again. Use it when a key or secret leaked, or when the status page says so |

## Administering the site

Sign in as a superadmin, or as a member of the site's `admin` role, at
Identity Level 3 or higher (Google, for example; an emailed link is not
enough). Then open:

```
https://www.example.com/api/admin/status
```

The page checks whether the database matches the deployed code
([status.md](status.md)). It is read-only. A signed-out visit goes to sign-in
and comes back. A person without the role gets a 403 that offers another
account.

Each failing check names a fix that needs no terminal: "run the deploy
workflow again", "run it by hand with these options", or a line to add to
`wrangler.jsonc` in GitHub's editor. The command for the same fix is shown
under it.

Upgrades, segment changes, and every other admin route still need the admin
key. CI covers upgrades; the rest is work for a server or a script.

## The production admin key

The workflow stores production's admin key as the Worker secret
`E9_ADMIN_API_KEY`. Cloudflare never shows a secret again, so no person ever
holds it. That is intended:

- Upgrades run in the workflow with a temporary key (`--remote`).
- Status is the browser page above.
- A command run elsewhere that needs admin access (`e9core status`,
  `segment`, `installDefaultPlugins`) takes `--remote` in any folder with
  the site's `wrangler.jsonc` and a Cloudflare token.

To replace the key, run the workflow with `rotate`.

## Agents

An agent session that writes the site's code needs no Cloudflare login and
no secrets. It commits and pushes; the workflow sets up, deploys, and
upgrades. Do not ask the owner to run a command or to paste a value. When
something fails, read the workflow's log and the status page, and change the
code or the workflow inputs.

## What this needs from the site

- `@engine9/core` and `@engine9/schemas` in `package.json`, and the
  `package-lock.json` committed (`npm ci` installs from it).
- `wrangler.jsonc` committed. Setup adds what it needs on the runner (the D1
  database id, the plugin build step). Commit what it adds when you can, so
  the file in the repository matches the deployed Worker.

To pick up a new `@engine9/schemas`, change its version in `package.json`
and `package-lock.json` (Dependabot can open that pull request) and merge.
The workflow deploys and upgrades.
