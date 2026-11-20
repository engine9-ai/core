# Merge tools and linking logins

This page is for anyone who builds a tool that joins person records or
links sign-in logins to records: a plugin, the engine9 server, a CRM sync,
or an agent. Core has no such tool. Core keeps the one primitive (an
admin's link) and these rules.

## What core does, and does not do

A sign-in finds its person in `person_login` only
([auth/README.md](../auth/README.md#who-is-signing-in-logins-people-deduplication),
PERMISSIONS.md PL-13):

1. the Delegate account's login, then a `merged_from` login, then the
   verified address's login;
2. with none of these, a new person.

A grant by email with no login is also a new person. Core never sends a
sign-in or a grant to a record because the address is on it.

A login reaches a record that already exists in three ways only:

| Way | Who | When |
| --- | --- | --- |
| `e9core signin link --email … --person <id>` (or `--subject`), `POST /api/admin/logins` with `action: "link"` | An admin, one login at a time | Before an invitation, or to fix a sign-in |
| The login plugin's upgrade copy (`@engine9/schemas/login`) | `e9core upgrade` | Once, when sign-in is turned on |
| A merge tool that follows this page | The tool's operator | Whenever it runs |

## Why sign-in never uses dedupe

Dedupe files data. It joins two rows when they share any identifier: an
address, a phone, a CRM id. Public forms write it. Each of these rules is
safe alone. Together with "a sign-in finds the record its address is on"
they are a takeover:

1. Phone X belongs to a donor on file. Nobody signs in as the donor.
2. Someone submits a form with phone X and their own address. Dedupe
   matches the phone and files their address on the donor's record.
3. They sign in with their own address, which they really control.
4. If sign-in looked the address up, it would find the donor's record, and
   they would see the donor's history.

Running dedupe later, in a batch, does not help. If the merge comes before
the sign-in, step 4 is the same. If it comes after, their login already
sits on their own record, and merging the donor's record into it hands the
history over anyway. Anything that joins records or links logins can
recreate this. That is why the rules below exist.

## Rules for any merge tool

### 1. A login is access

A `person_login` row says "whoever proves this address or Delegate account
sees this record". Moving a login, linking one, or merging a record that a
login points at changes who can read what. Treat each of these as a
permission change:

- admin scope only, never a `people:write` or public key;
- a dry run that lists every login and record it would touch;
- an `audit` record for every change (never the data log, `logger`).

### 2. Change logins only through core

Do not write `person_login` with SQL. Use core's functions
(`linkLogin`, `lockLogin`, `retireLogin` in
[auth/logins.js](../auth/logins.js)), `e9core signin`, or
`POST /api/admin/logins`. They keep the subject binding, the audit record,
and the state rules. Retire a login; never delete its row.

### 3. "The address is on record R" is not evidence

Dedupe output says where data was filed, not who owns a record. An address
on R may have been joined through a phone or a CRM id that someone else
typed. Never link a login, or fold a record into a login's person, because
an address or phone matches.

### 4. The one automatic rule that is safe

Fold record R into the person P of a login only when **P's logins prove
everything that identifies R**:

- every email address on R is an active email login of P (proven by
  Delegate at Identity Level 2 or above);
- R has no phone, CRM id, or other identifier that P has not proven;
- R has no login of its own and holds no role (`roles` plugin segments).

If any check fails, put the pair in a queue for a person to decide.

Check the takeover against this rule. The donor's record holds the donor's
address and phone X. The person who signed in proved only their own
address. They proved neither of the donor's identifiers, so nothing is
folded. A newsletter record that holds only `E` is folded into the login
that proved `E`. The worst case runs the safe way: whoever proved `E`
receives something another person typed under `E`. Nobody receives anyone
else's history.

### 5. Fold toward the login, never the other way

Keep P's `person_id` and move R's rows to it. Never move P's logins onto
R automatically: that gives R's history to whoever holds P's logins, which
is rule 4 skipped.

### 6. Never merge two records that both have logins

Two records with logins are two people, or one person with two accounts.
The person joins their own accounts with **Add a sign-in address** in the
Login button, which needs both accounts at once. An admin can link by hand.
A tool never does it alone.

### 7. Linking in bulk (link first, then invite)

To let people on file reach their history at their first sign-in, link
their addresses before inviting them:

- Take the addresses from a named, trusted source: the CRM's primary
  address of each record, or an import file. Never "every address in
  `person_email`": that includes addresses forms joined.
- Skip and report an address that is on more than one record.
- Link with `linkLogin` or `e9core signin link` (`how: granted`, no
  subject). The first Delegate account to sign in with the address binds
  to it, and core refuses any other account later (`login_reassigned`).
- The invitation email is only a message. Delegate's check of the address
  is the proof.

The login plugin's upgrade copy (`all_addresses`) does this once, for every
address on file, when sign-in is turned on. Addresses that arrive later are
never logins until something links them.

### 8. Moving the data

A merge moves every row on R: the person tables, `person_segment`,
transactions, timeline, and the identifier store's identifiers (so dedupe
files future rows on P). Then it removes R. A login still on R is linked
to P (rule 2) or retired first, never left pointing at a deleted person.

### 9. Roles

Segment membership moves with a merge. A role segment on R would give its
access to P's logins. The dry run lists role memberships, and a record
holding a role is never folded automatically (rule 4).

## Tests a merge tool needs

At least these, on SQLite and on D1:

- The takeover, both orders. A form files the intruder's address on the
  donor's record through the donor's phone, and the intruder signs in
  before, and after, the tool runs. The tool folds nothing into the
  intruder's person.
- A newsletter record with only the login's proven address is folded.
- Two records with logins are never merged.
- A record holding a role is queued, not folded.
- Every login change appears in the audit log, and a dry run changes
  nothing.
