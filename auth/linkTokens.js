/*
  Link tokens: a signed note in an email link that says which person the
  email went to, so a one-click form on the site (a petition, a survey
  answer) is filed on that person without anyone signing in.

  A sender (the engine9 server's email plugin, a CRM, a partner) holds a
  private key and signs one token per recipient when it builds the message.
  The site lists each sender's public key (`config.linkIssuers`,
  E9_LINK_ISSUERS on the shipped Worker). Public keys are not secret; the
  private key never leaves the sender. Dropping a sender from the list
  revokes every token it made.

  A token is a JWT (RFC 7519), ES256, header `typ: e9-link+jwt`:

    iss  the sender's name, as the site lists it
    aud  the site's account (worker.accountHandle): a token for one
         account does nothing at another, even from the same sender
    sub  the recipient's person_id
    src  optional: the message's source code (attribution)
    exp  required

  It is write-only. It files a POST /people row on `sub` and nothing else:
  never a session, a role, or a read, because emails are forwarded. It never
  signs anyone in, and a token that says `login` is refused (sign-in links
  are core's own, made by an admin: see auth/logins.js). The rules for the
  row are in api/publicRows.js (applyLinkToken).

  Verifying needs no database and no network: the keys are in config.
*/
import { SignJWT, jwtVerify, importJWK, exportJWK, generateKeyPair, decodeJwt, decodeProtectedHeader } from 'jose';

export const LINK_TOKEN_TYPE = 'e9-link+jwt';
export const LINK_TOKEN_ALG = 'ES256';
const ISSUER_NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/i;

function issuerProblem(entry, i) {
  const where = `link issuer ${i + 1}`;
  if (!entry || typeof entry !== 'object') return `${where} must be an object { name, publicKey }`;
  if (!ISSUER_NAME.test(String(entry.name || ''))) return `${where}: name must be letters, digits, ".", "_" or "-"`;
  const key = entry.publicKey;
  if (!key || typeof key !== 'object') return `${where} (${entry.name}): publicKey must be a JWK`;
  if (key.d !== undefined) return `${where} (${entry.name}): that is a private key. List only the public key; the sender keeps the private one`;
  if (key.kty !== 'EC' || key.crv !== 'P-256') return `${where} (${entry.name}): publicKey must be an ES256 key (kty EC, crv P-256)`;
  return null;
}

/**
 * The senders a site trusts, from config: an array, or JSON text of one.
 * Throws on a malformed entry (a private key pasted by mistake included).
 */
export function parseLinkIssuers(value) {
  if (value == null || value === '') return [];
  let list = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      throw new Error('E9_LINK_ISSUERS must be a JSON array of { name, publicKey }');
    }
  }
  if (!Array.isArray(list)) throw new Error('link issuers must be an array of { name, publicKey }');
  const seen = new Set();
  return list.map((entry, i) => {
    const problem = issuerProblem(entry, i);
    if (problem) throw new Error(problem);
    const name = String(entry.name);
    if (seen.has(name)) throw new Error(`link issuer "${name}" is listed twice`);
    seen.add(name);
    return { name, publicKey: entry.publicKey };
  });
}

const keyCache = new WeakMap();
async function issuerKey(issuer) {
  let key = keyCache.get(issuer.publicKey);
  if (!key) {
    key = await importJWK(issuer.publicKey, LINK_TOKEN_ALG);
    keyCache.set(issuer.publicKey, key);
  }
  return key;
}

function refused(reason) {
  return { ok: false, reason };
}

/**
 * Check a link token. Returns { ok: true, issuer, personId, sourceCode, exp }
 * or { ok: false, reason } (a reason a warning can show; never throws for a
 * bad token).
 */
export async function verifyLinkToken(token, { issuers = [], audience } = {}) {
  if (!token || typeof token !== 'string') return refused('no link token');
  if (!audience) return refused('this site has no link-token audience');
  let claims;
  let header;
  try {
    claims = decodeJwt(token);
    header = decodeProtectedHeader(token);
  } catch {
    return refused('not a link token');
  }
  if (header.typ !== LINK_TOKEN_TYPE) return refused('not a link token');
  const issuer = issuers.find((x) => x.name === claims.iss);
  if (!issuer) return refused('the sender is not one this site trusts');
  let payload;
  try {
    ({ payload } = await jwtVerify(token, await issuerKey(issuer), {
      algorithms: [LINK_TOKEN_ALG],
      typ: LINK_TOKEN_TYPE,
      issuer: issuer.name,
      audience: String(audience),
      requiredClaims: ['sub', 'exp']
    }));
  } catch (e) {
    return refused(e?.code === 'ERR_JWT_EXPIRED' ? 'the link token has expired' : 'the link token is not valid for this site');
  }
  if (payload.login) return refused('a link token cannot sign anyone in');
  const personId = Number(payload.sub);
  if (!Number.isInteger(personId) || personId <= 0) return refused('the link token does not name a person');
  const sourceCode = typeof payload.src === 'string' && payload.src.trim() ? payload.src.trim() : undefined;
  return { ok: true, issuer: issuer.name, personId, sourceCode, exp: payload.exp };
}

/**
 * Make a link token (for a sender, or a test). `privateKey` is the sender's
 * private JWK; `issuer` its name as the site lists it; `audience` the site's
 * account handle. `expiresIn` is seconds or a jose time span ('90d').
 */
export async function createLinkToken({ privateKey, issuer, audience, personId, sourceCode, expiresIn = '90d' }) {
  if (!privateKey?.d) throw new Error('createLinkToken needs the private key (a JWK with "d")');
  if (!ISSUER_NAME.test(String(issuer || ''))) throw new Error('createLinkToken needs the issuer name the site lists');
  if (!audience) throw new Error("createLinkToken needs the audience: the site's account handle");
  const id = Number(personId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('createLinkToken needs a person_id');
  const claims = sourceCode ? { src: String(sourceCode) } : {};
  const header = { alg: LINK_TOKEN_ALG, typ: LINK_TOKEN_TYPE };
  if (privateKey.kid) header.kid = privateKey.kid;
  return new SignJWT(claims)
    .setProtectedHeader(header)
    .setIssuer(String(issuer))
    .setAudience(String(audience))
    .setSubject(String(id))
    .setIssuedAt()
    .setExpirationTime(typeof expiresIn === 'number' ? Math.floor(Date.now() / 1000) + expiresIn : expiresIn)
    .sign(await importJWK(privateKey, LINK_TOKEN_ALG));
}

/**
 * A new sender key pair. The sender keeps `privateKey`; the site adds
 * `issuer` ({ name, publicKey }) to its list.
 */
export async function generateLinkIssuer({ name }) {
  if (!ISSUER_NAME.test(String(name || ''))) throw new Error('name must be letters, digits, ".", "_" or "-"');
  const { privateKey, publicKey } = await generateKeyPair(LINK_TOKEN_ALG, { extractable: true });
  const kid = `${name}-${new Date().toISOString().slice(0, 10)}`;
  const priv = { ...(await exportJWK(privateKey)), kid, alg: LINK_TOKEN_ALG };
  const pub = { ...(await exportJWK(publicKey)), kid, alg: LINK_TOKEN_ALG, use: 'sig' };
  return { privateKey: priv, issuer: { name: String(name), publicKey: pub } };
}

export default { parseLinkIssuers, verifyLinkToken, createLinkToken, generateLinkIssuer, LINK_TOKEN_TYPE };
