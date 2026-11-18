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

- someone signing in, which adds them as a new person or a matching record
  nobody signs in as yet;
- an administrator giving someone access by email;
- the upgrade, which copies today's administrators onto the list.

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
   every current administrator onto it, with all of their email addresses.

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

The dry run tells you how many administrators it will copy (`person_login`:
`role_holders`, `addresses`) and lists anything it cannot copy (below).

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

Nothing breaks. Until the upgrade runs, sign-in works exactly as it did, and
`e9core status` says so in plain words:

> **Sign-in is still using the old rules: run the upgrade**

Run the upgrade soon: until you do, the site does not have the new protection.

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
  sign-in finds their record but without administrator access. Another
  administrator restores it: `npx e9core signin explain --person <id>`,
  then `npx e9core signin link --subject <the account> --person <id>`.
- **One email address was on two administrators' records.** The upgrade
  cannot tell whose it is, so it copies it for neither and lists it in the
  upgrade result (`conflicts`). Give it to the right person:
  `npx e9core signin link --email <address> --person <id>`.

A superadmin (the superadmins file, matched by a confirmed email) has full
access on whatever account they sign in with, so a site always has a way back
in, even when every administrator is stuck.

## What people signing in will notice

Almost always, nothing. The Login button looks the same.

A person who has more than one email address on file, and signs in with a
different one than last time, now sees a message in the Login button instead
of quietly getting a second, empty account:

> This email address belongs to someone here who signs in with a different
> address: v\*\*\*x@g\*\*\*l.com. Sign in with that address instead.

It offers two choices:

- **Sign in with a different address.** Delegate opens with the person's
  addresses to pick from, a way to add one, or an emailed code.
- **This isn't me: continue with this address.** For two people who share
  one record, such as a household. It makes a separate account.

Two other messages say to ask the site's administrator: an address now used
by a different Delegate account (someone reused an old colleague's address),
and a sign-in an administrator turned off.

People can now add a second address themselves, in the Login button's
dialog, and then stop using the old one.

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
| Code that grants a role by email (`addPeople`, `segment add --email`, `POST /api/auth/segments`) | Works as before. The address gets a login. If the address is on a record someone else signs in as, the grant makes a new person and says so (`notes`); use `e9core signin link` if that was the intent |
| The server's `rolesForEmail({ worker, email, roleIds })` | Reads the sign-in list only. Pass `subject` when you have it |
| A sign-in page of the site's own around `auth.login` | Handle the three new reasons (`other_login`, `login_reassigned`, `login_locked`), or use the Login button, which does |
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
`npx e9core upgrade --backfill-logins`.
It adds missing addresses only and never changes a login that was locked or
retired.

### A new site, or a site adding sign-in later

No edition includes the login plugin: a site that signs people in adds it on
purpose. A new site lists it after the edition in `package.json`, before
`setup` creates the databases:

```json
"engine9": { "install": ["@engine9/schemas/editions/contact", "@engine9/schemas/login"] }
```

A site that already has a database adds it, and copies today's
administrators in, with `npx e9core upgrade --plugin @engine9/schemas/login`.

## Reference

- How sign-in decides: [sign-in.md](sign-in.md#who-is-signing-in) and
  [auth/README.md](../auth/README.md).
- Requirements: [PERMISSIONS.md](../PERMISSIONS.md) PL-13.
- The upgrade: `person_login` in `@engine9/schemas/login`.
