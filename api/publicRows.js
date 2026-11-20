/*
  The input filter for keys a browser holds (any key with the `public`
  scope): POST /people rows from a form.

  A form names a person by what the person typed (an email, a phone), never
  by fields that point the row at a record directly. Those fields are
  removed from public rows, each with a warning, and the request still
  succeeds:

    person_id            unless it is the signed-in person's own, on a
                         row with no email or the session's own address
    identifiers          raw identifier rows
    delegate_id, delegate_merged_from
                         Domain UNIDs; only sign-in writes them
    email_hash_*, phone_hash_*
                         hashes stand for an address the form never saw
    confirmation_status  verification is recorded by the system
    remote_person_id     only "<plugin uuid>.<id>", another system's id
    input_id             an input's id; a form names its input with
                         options.remoteInputId
    remote_input_id      'delegate' (any case), on the row or in
                         options.remoteInputId: reserved for sign-in

  Field names are compared after the same normalization the people pipeline
  applies first (lower case; anything but a-z, 0-9, "_" and "." becomes
  "_"), and the rows come back with those names: `PERSON_ID` or
  `Delegate-ID` is the field the pipeline would read, so it is filtered
  like it.

  Everything else is unchanged: the row goes through the people pipeline and
  dedupe exactly as before. This is a pure function of the request. It reads
  nothing from the database and knows nothing about sign-in.

  Server-side keys (people:write, tables:write, admin) are not filtered:
  imports and syncs may join identities. A public form cannot.
*/

export const STEERING_FIELDS = [
  'identifiers',
  'delegate_id',
  'delegate_merged_from',
  'email_hash_v1',
  'email_hash_md5',
  'phone_hash_v1',
  'phone_hash_md5',
  'confirmation_status'
];

/** The input id sign-in writes under. A public key cannot write as sign-in. */
export const SIGN_IN_INPUT_ID = 'delegate';

/** The field name the people pipeline reads (@engine9/schemas person normalize_field_names). */
export function pipelineFieldName(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9_.]/g, '_');
}

/** A row with the field names the pipeline will see (a later key wins, as there). */
export function normalizeRowKeys(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) out[pipelineFieldName(k)] = v;
  return out;
}

/** True when an input id is sign-in's, in any case. */
export const isSignInInput = (value) => String(value ?? '').trim().toLowerCase() === SIGN_IN_INPUT_ID;

// "<plugin uuid>.<id>": another system's id, which only that system's import may use.
const PLUGIN_REMOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\./i;

const lower = (v) => String(v ?? '').trim().toLowerCase();

/**
 * Public rows with the steering fields removed, and a warning for each one
 * removed ({ field, row, reason }). `session` is the signed-in session
 * ({ personId, email }), or null.
 */
export function filterPublicRows(people, { session = null } = {}) {
  const sessionPersonId = Number.isInteger(session?.personId) ? session.personId : null;
  const sessionEmail = lower(session?.email);
  const warnings = [];
  const rows = (people || []).map((input, i) => {
    const row = normalizeRowKeys(input);
    const warn = (field, reason) => warnings.push({ field, row: i, reason });
    for (const k of STEERING_FIELDS) {
      if (k in row) {
        delete row[k];
        warn(k, k === 'confirmation_status' ? 'verification is recorded by the system, not a form' : 'a public row cannot choose the person it is filed under');
      }
    }
    if ('input_id' in row) {
      delete row.input_id;
      warn('input_id', 'a form names its input with options.remoteInputId');
    }
    if (isSignInInput(row.remote_input_id)) {
      delete row.remote_input_id;
      warn('remote_input_id', 'reserved for sign-in');
    }
    if (row.remote_person_id != null && PLUGIN_REMOTE_ID.test(String(row.remote_person_id))) {
      delete row.remote_person_id;
      warn('remote_person_id', "another system's id; only that system's import may use it");
    }
    if (row.person_id != null) {
      const own = sessionPersonId != null && Number(row.person_id) === sessionPersonId;
      const email = lower(row.email);
      if (!own) {
        delete row.person_id;
        warn('person_id', sessionPersonId == null ? 'a public row is filed by what the person typed' : 'not the signed-in person');
      } else if (email && email !== sessionEmail) {
        // Another address on the signed-in record would block that address's
        // owner at sign-in. A new sign-in address is the Login button's job.
        delete row.person_id;
        warn('person_id', 'the row names an address the person is not signed in with; it is filed by that address');
      }
    }
    return row;
  });
  return { rows, warnings };
}

/*
  A verified link token (auth/linkTokens.js) on a POST /people request. It
  says which person an email went to; it files the row on that person only
  when nothing else in the request says who the person is:

  - the request has one row (a token is one recipient);
  - the row has no person_id left after the filter (a signed-in person is
    stronger proof than a forwarded link);
  - the row has no email, phone (or cell, mobile, mobile_phone), or
    remote_person_id. A row with an address
    is filed by that address, as any form row is: a forwarded link plus the
    reader's own address lands on the reader. The token never joins a new
    identifier to its person.

  Its `src` fills the row's source_code when the request set none, in every
  case. A pure function, like filterPublicRows: the caller verified the
  token and checked that the person exists.
*/
const IDENTIFYING_FIELDS = ['email', 'phone', 'cell', 'mobile', 'mobile_phone', 'remote_person_id'];

export function applyLinkToken(rows, link, { defaultSourceCode } = {}) {
  const warnings = [];
  if (!link?.ok) return { rows, warnings, filed: false };
  const out = rows.map((r) => normalizeRowKeys(r));
  if (link.sourceCode && !defaultSourceCode) {
    for (const r of out) if (r.source_code == null || String(r.source_code).trim() === '') r.source_code = link.sourceCode;
  }
  const warn = (reason) => warnings.push({ field: 'options.linkToken', reason });
  if (out.length !== 1) {
    warn('a link token is one recipient; it is used only on a request with one row');
    return { rows: out, warnings, filed: false };
  }
  const row = out[0];
  if (row.person_id != null) {
    warn('the row is filed on the signed-in person');
    return { rows: out, warnings, filed: false };
  }
  const named = IDENTIFYING_FIELDS.filter((k) => row[k] != null && String(row[k]).trim() !== '');
  if (named.length) {
    warn(`the row is filed by its ${named[0]}, not the link`);
    return { rows: out, warnings, filed: false };
  }
  row.person_id = link.personId;
  return { rows: out, warnings, filed: true };
}
