# Upgrading to @engine9/core 1.22 and @engine9/schemas 1.15

This release changes how a site decides who someone is when they sign in.
Do it for every site. It takes the usual three steps, and nobody loses
access along the way.

## In plain words

Until now, when someone signed in, the site matched their email address
against everything it had on file, including addresses typed into public
forms. Someone could fill in a form in a way that tied their own address to
an administrator's record, then sign in as that administrator.

From this release, each site keeps a short list of **who can sign in, and as
which person**, much like the list of accounts on a computer. Only three
things add to it:

- someone signing in for the first time, which adds them as a new person;
- an administrator giving someone access by email, or linking an address to
  a record that already exists;
- the upgrade, which copies today's administrators, and everyone who has
  signed in before, onto the list.

A first sign-in never matches a record because the address is on it. Forms
can attach an address to a record through other details, such as a phone
number, so an address on a record does not prove whose record it is.

Forms keep working as before. A form can no longer point its row at
someone else's record (by a record number or a hidden id), and nothing a form
writes changes who someone signs in as.

The list is a plugin of its own, the **login plugin**
(`@engine9/schemas/login`). A site where people sign in needs it. A database
that only stores data, where nobody signs in, does not, and the upgrade
leaves it alone.

## What you need to do

The same three steps as every release:

1. **Update the packages.**
2. **Deploy.**
3. **Run the upgrade.** This step matters this time: on a site where people
   sign in, it adds the login plugin, builds the sign-in list, and copies
   onto it every current administrator, with all of their email addresses,
   and every address people have already signed in with.

Before step 3, decide one thing: **should people on file who have never
signed in find their own record the first time they do?** Imported donors
or members, for example, who should see their history. If yes, add
`--all-addresses` to the upgrade, once (next section). If not, they get a
fresh record at their first sign-in, and an administrator can link
anyone's address to their record later.

**If your site is set up in GitHub only (no terminal):** run the deploy
workflow (GitHub: Actions, Deploy, Run workflow). It updates, deploys, and
upgrades in one go. See [no-command-line.md](no-command-line.md).

**With a terminal:**

```bash
npm install @engine9/core@^1.22.0 @engine9/schemas@^1.15.0
npx wrangler deploy            # Cloudflare; a Node site restarts instead
npx e9core upgrade --url https://www.example.com --dry-run
npx e9core upgrade --url https://www.example.com
npx e9core status --url https://www.example.com
```

The dry run tells you how many addresses it will copy (`person_login`:
`role_holders`, `addresses`) and lists anything it cannot copy (below).

### People on file who have never signed in

By default the upgrade copies administrators' addresses and the addresses
people already signed in with. To copy **every** address on file as well:

```bash
npx e9core upgrade --url https://www.example.com --all-addresses --dry-run
npx e9core upgrade --url https://www.example.com --all-addresses
```

In GitHub only: run the deploy workflow by hand with command `upgrade` and
options `--all-addresses`.

Do this once, when sign-in is turned on. An address that is on two records
is copied for neither and listed under `conflicts`. Addresses that arrive
after the upgrade (a form, an import) are never on the list until an
administrator links them:

```bash
npx e9core signin link --email dana@example.org --person 1234
```

Then invite the person. Their first sign-in lands on record 1234. Tools that
link many addresses, or join records, follow [merge-tools.md](merge-tools.md).

### How the upgrade knows your site has sign-in

You do not have to tell it. It adds the login plugin when any of these is
true:

- the upgrade runs through your site (`--url`, or the deploy workflow) and
  the site has sign-in set up;
- anyone holds a role, such as administrator.

If neither is true, the database only stores data, and the upgrade leaves it
without sign-in.

**If nobody can sign in after the upgrade** (the Login button says "This site
does not have sign-in yet"), the upgrade could not tell. It happens only
when the upgrade ran with `--db` on a site that has no administrators. Add
the plugin:

```bash
npx e9core upgrade --plugin @engine9/schemas/login --url https://www.example.com
```

In GitHub only: run the deploy workflow by hand with command `upgrade` and
options `--plugin @engine9/schemas/login`.

### Between the deploy and the upgrade

Nothing breaks. Until the upgrade runs, sign-in finds people as it did, and
`e9core status` says so in plain words:

> **Sign-in is still using the old rules: run the upgrade**

Run the upgrade soon: until you do, the site does not have the new protection.

One change starts at the deploy: sign-in now always confirms an email
address or phone (Identity Level 2). Only a site that signed people in with
less (`signIn.minLevel` 0 or 1) notices; see
[What people signing in will notice](#what-people-signing-in-will-notice).

### After the upgrade

`e9core status` (or the status page, `/api/admin/status`, opened in a
browser as an administrator) shows three new lines:

| Line | What it means | What to do |
| --- | --- | --- |
| Sign-in uses person_login | The upgrade ran | Nothing |
| *Sign-in is set up, but the login plugin is not installed* | Nobody can sign in | Add the plugin (above) |
| Every role holder can sign in | Each administrator has at least one address on the list | Nothing |
| *N role holders have no way to sign in* | See below | See below |
| Every role holder signed in within 90 days | Nobody with access has gone quiet | Nothing |
| *N role holders have not signed in for 90 days* | Someone with access has not used it in three months | Check whether they still need it |

**"Role holders have no way to sign in"** happens in two cases, both rare:

- **Someone signs in through Facebook or Microsoft and never confirmed an
  email address there.** The upgrade has no address to copy. Their next
  sign-in finds their record by their Delegate account, with their access,
  and the line clears.
- **One email address was on two administrators' records.** The upgrade
  cannot tell whose it is, so it copies it for neither and lists it in the
  upgrade result (`conflicts`). Give it to the right person:
  `npx e9core signin link --email <address> --person <id>`.

A superadmin (the superadmins file, matched by a confirmed email) has full
access on whatever account they sign in with, so a site always has a way back
in, even when every administrator is stuck.

## What people signing in will notice

Almost always, nothing. The Login button looks the same.

Someone who is on file but whose address is not on the list (they never
signed in, and nobody linked them) gets a fresh record at their first
sign-in. They do not see the old record's history until an administrator
links their address to it. Two people who share one record, such as a
household, each get their own.

Someone who signed in before without an email address (with a phone, or a
Microsoft or Facebook account that shared none) also gets a fresh record at
their next sign-in. If they hold a role, `e9core status` lists them under
`login.review`: give the role to their new record
(`npx e9core segment add --segment admin --person-id <new id>`).

Two messages say to ask the site's administrator: an address now used by a
different Delegate account (someone reused an old colleague's address), and
a sign-in an administrator turned off.

People can now add a second address themselves, in the Login button's
dialog, and then stop using the old one.

Sign-in now always confirms an email address or a phone (Identity Level 2).
On a site that used to sign people in with less (`signIn.minLevel` 0 or 1),
those people get an emailed code or a provider sign-in, and anyone signed
in at a lower level is signed out once. People who only fill in forms or
open emails are not asked to sign in: their petition, their sends, and
their clicks join by the address they send.

## For the person who maintains the code

Search the site's code for what changed:

```bash
rg -n "person_id|identifiers|remoteInputId|issueToken|rolesForPerson|rolesForEmail|resolveDelegatePersonId|login_error" . -g '!node_modules' -g '!dist' -g '!.wrangler'
```

| What you find | What changes |
| --- | --- |
| A form that sends `person_id`, `identifiers`, `delegate_id`, hashes, `confirmation_status`, or a `<plugin>.<id>` `remote_person_id` with the public key | Those fields are removed, and the response lists each one in `warnings`. The request still succeeds, and the rest of the row is saved as before. A `person_id` stays only when it is the signed-in person's own and the row has no email or the signed-in address |
| A signed-in profile form that changes the person's email by sending their `person_id` with a new address | The row is saved under the new address, not the signed-in person. A new sign-in address is the Login button's **Add a sign-in address** |
| A form that sends `options.remoteInputId: 'delegate'` with the public key | Ignored, with a warning: that input is sign-in's. Any other value works as before |
| Code that mints a Core Session with `issueToken({ personId, roles })`, on a site with the login plugin | Roles are read from the database on every request, never from the token. Give the person the role (`person_segment`) and a login (`e9core signin link`). Without the login plugin, sessions work as before |
| A Delegate sign-in at Identity Level 2 whose email is not verified (a verified phone) | The address is no longer used to find the person. Every site, with or without the login plugin |
| Code that grants a role by email (`addPeople`, `segment add --email`, `POST /api/auth/segments`) | The address gets a login. An address with no login gets a new person, never the record the address is on; `notes` names that record. To grant on an existing record, `e9core signin link` the address there first, then grant |
| Code that writes a people row with its own `person_id` | Unchanged, except that the pipeline no longer creates an extra, empty person for it |
| A tool that merges records or links logins in bulk | Follow [merge-tools.md](merge-tools.md) |
| The server's `rolesForEmail({ worker, email, roleIds })` | Reads the sign-in list only. Pass `subject` when you have it |
| A sign-in page of the site's own around `auth.login` | Handle the new reasons (`login_reassigned`, `login_locked`, `sign_in_off`, `level_too_low`), or use the Login button, which does |
| `signIn.minLevel` (or `E9_SIGN_IN`) set to 0 or 1, or `identityUrl({ minLevel: 1 })` | Core asks Delegate for Level 2 anyway. Set `2` or remove it. A role with `join_min_level` or `requiredAuth.minLevel` 1 now means anyone signed in |
| A page that follows people who do not sign in through a Level 0 or 1 Delegate session | Put the address in the form posted with the public key, and import sends and clicks with the email provider's plugin. Delegate is for signing in |
| An agent host that maps an Agent Credential to a person | Call `personForSignIn({ worker, identity, readOnly: true })` from `@engine9/core/auth/logins` on each request |

New commands, for administrators (`--db` or `--url` with the admin key):

```bash
npx e9core signin list    --person <id> | --email <address>
npx e9core signin explain --email <address>
npx e9core signin link    --email <address> --person <id>
npx e9core signin lock    --email <address>
npx e9core signin unlock  --email <address>
npx e9core signin retire  --person <id>       # offboarding
```

Offboarding is now: `signin retire --person <id>`, then remove the role. A
retired address reused later by someone new gets a new, empty account.

### If a site's roles are not in the roles plugin

The upgrade copies members of the segments the account's `roles` plugin made
(`e9core segment add` and `roles: 'standard'` make them there). Through the
site (`--url`, the deploy workflow) it also copies the members of every role
in the site's `config.roles`. Running it with `--db` against a site with its
own role segments, pass them: `npx e9core upgrade --db … --role-segments <id>,<id>`.

### Running the copy again

The upgrade runs once: after it, the list exists and the upgrade reports
`current`. If the list was created some other way (`e9core install --plugin
@engine9/schemas/login` on a database that already had administrators),
`e9core status` shows role holders with no way to sign in. Then:
`npx e9core upgrade --backfill-logins`. It copies addresses only for role
holders who have no login at all, and never changes an existing login.
`--all-addresses` works only on the run that turns sign-in on: an address
joined to a record after that is never a login until an administrator
links it.

### A new site, or a site adding sign-in later

No edition includes the login plugin: a site that signs people in adds it on
purpose. A new site lists it after the edition in `package.json`, before
`setup` creates the databases:

```json
"engine9": { "install": ["@engine9/schemas/editions/contact", "@engine9/schemas/login"] }
```

A site that already has a database adds it, and copies today's
administrators in, with `npx e9core upgrade --plugin @engine9/schemas/login`
(add `--all-addresses` to copy every address on file).

## Reference

- How sign-in decides: [sign-in.md](sign-in.md#who-is-signing-in) and
  [auth/README.md](../auth/README.md).
- Requirements: [PERMISSIONS.md](../PERMISSIONS.md) PL-13.
- The upgrade: `person_login` in `@engine9/schemas/login`.
- Joining records and linking logins: [merge-tools.md](merge-tools.md).
