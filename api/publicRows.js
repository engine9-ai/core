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
    options.remoteInputId 'delegate'
                         reserved for sign-in

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
    const row = { ...(input || {}) };
    const warn = (field, reason) => warnings.push({ field, row: i, reason });
    for (const k of STEERING_FIELDS) {
      if (k in row) {
        delete row[k];
        warn(k, k === 'confirmation_status' ? 'verification is recorded by the system, not a form' : 'a public row cannot choose the person it is filed under');
      }
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
