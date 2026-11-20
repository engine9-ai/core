# Link tokens: one-click forms in email

An email asks two million people to sign a petition. None of them signs
in. The send, the click, and the signature should all land on the same
person.

- **Sends and clicks** come from the email provider's plugin, imported
  with a server key and the address (or the provider's id for it).
- **A petition form where the person types their address** posts it with
  the public key. Dedupe files it on the same person. Nothing else is
  needed.
- **A one-click petition** (the link signs, nothing is typed) carries a
  **link token**: a note, signed by whoever sent the email, that says
  which person it went to. This page is about that note.

A link token files one form row on one person. It is never a session, never
a role, never a read, and it never signs anyone in: emails are forwarded.
To sign someone in by email, an admin sends a sign-in link instead
([sign-in.md](sign-in.md#sign-in-links)).

## How it works

1. A **sender** (the engine9 server's email plugin, a CRM, a partner
   organization) has a key pair. It keeps the private key.
2. The **site** lists the sender's public key. Public keys are not secret.
3. When the sender builds a message, it signs one token per recipient
   with the recipient's `person_id`, and puts it in the link:
   `https://www.example.org/petition?e9t=<token>`.
4. The petition page posts the token with the row:

   ```js
   const linkToken = new URLSearchParams(location.search).get('e9t');
   await fetch('/api/people', {
     method: 'POST',
     headers: { authorization: `Bearer ${PUBLIC_KEY}`, 'content-type': 'application/json' },
     body: JSON.stringify({ people: [{ /* the action, no address */ }], options: { linkToken } })
   });
   ```

5. Core checks the signature against the listed keys (no database read and
   no network call) and files the row on that person.

Making a token is one signature, so millions of them take seconds. Nothing
goes to Delegate.

## What a token does to a row

| The request | Filed on |
| --- | --- |
| One row with no email, phone (`cell`, `mobile`, `mobile_phone`), or `remote_person_id` | The token's person |
| A row with an email or phone | That address, as any form row. A forwarded link plus the reader's own address lands on the reader. The token never joins an address to its person |
| A signed-in person's own row | The signed-in person |
| More than one row | Each row as usual: a token is one recipient |
| A token that is expired, for another account, from a sender the site does not list, or for a person the site does not have | Each row as usual |

Each case where the token is not used adds a `warnings` entry on the
response; the request still succeeds. The token's `src`, when present,
becomes the row's source code if the request set none. The data log records
the sender's name on each request that carried a token.

One limit is inherent in one-click links: someone holding a forwarded link
who types nothing acts as the person it was sent to. That puts wrong data
on one record. It never gives access: sign-in never reads form data
([merge-tools.md](merge-tools.md#why-sign-in-never-uses-dedupe)).

## For the site

Make a key pair for each sender (or let the sender make its own):

```bash
npx e9core link-token keys --name acme > acme-keys.json
```

Give the sender `privateKey` (it is theirs to keep secret). Add `issuer` to
the site's list. On the shipped Cloudflare Worker that is the
`E9_LINK_ISSUERS` variable, a JSON array:

```json
[{ "name": "acme", "publicKey": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…", "kid": "acme-2026-11-20", "alg": "ES256", "use": "sig" } }]
```

With `createApi`, pass the same array as `config.linkIssuers`. Core refuses
a private key in the list.

Tell the sender the site's **audience**: its account handle
(`E9_ACCOUNT_HANDLE`, else `E9_ACCOUNT_ID`). A token for one account does
nothing at another, even from the same sender. A site with its own value
sets `config.linkAudience`.

- **Revoke a sender:** remove its entry and deploy. Every token it made
  stops working.
- **Rotate a key:** add a second entry with a new name (`acme-2`), move the
  sender to it, then remove the old entry once its links have expired.

## For the sender

A token is a JWT (RFC 7519) signed with ES256, with header
`{ "alg": "ES256", "typ": "e9-link+jwt" }`:

| Claim | Value |
| --- | --- |
| `iss` | Your name, as the site lists it |
| `aud` | The site's account handle |
| `sub` | The recipient's `person_id`, as a string |
| `src` | Optional: the message's source code |
| `exp` | Required: when the link stops working (the campaign's life, such as 90 days) |

Any JWT library makes one. In Node.js, core has a helper:

```js
import { createLinkToken } from '@engine9/core/auth/linkTokens';
const token = await createLinkToken({
  privateKey, issuer: 'acme', audience: 'example-org', personId: 1234, sourceCode: 'petition-2026-11', expiresIn: '90d'
});
```

To make one by hand for a test:

```bash
npx e9core link-token make --key acme-keys.json --issuer acme --audience example-org --person 1234 --src petition-2026-11
```

Do not put `login` in a token: core refuses it. Do not sign tokens for
people the site has not given you.
