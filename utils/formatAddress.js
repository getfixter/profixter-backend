/**
 * One way to print an address and a phone number for Admin.
 *
 * THE UNIT AND line1.
 * Since sign-up started asking for an apartment or unit, the unit has been
 * folded into line1 when an address is saved (utils/addressVerification). That
 * is deliberate and stays: every address key (free-visit eligibility, the
 * duplicate-home check, the welcome offer) is built from line1, and "Apt 1" and
 * "Apt 2" must stay two homes. From this release the unit is ALSO kept on its
 * own (address.unit) so a screen can show and edit it as a separate field.
 *
 * So an address saved after this release usually has line1 "12 Oak St Apt 2"
 * and unit "Apt 2"; an older one has the unit only inside line1, or no unit at
 * all. splitUnit() gives the street without the unit whenever the unit is
 * known, and formatAddressLine() never prints the unit twice.
 */

const UNIT_PREFIX = /^(apt|apartment|unit|ste|suite|#|fl|floor|bldg|building|rm|room|no\.?|num)\b/i;

function clean(value, max = 200) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** "2" -> "Unit 2"; "Apt 2", "#2", "Suite 100" are kept as written. */
function unitLabel(unit) {
  const text = clean(unit, 40);
  if (!text) return "";
  if (UNIT_PREFIX.test(text) || text.startsWith("#")) return text;
  return `Unit ${text}`;
}

/** { street, unit }: line1 without a trailing copy of the unit, and the unit itself. */
function splitUnit({ line1, unit } = {}) {
  const street = clean(line1);
  const u = clean(unit, 40);
  if (!u) return { street, unit: "" };
  const lowerStreet = street.toLowerCase();
  const lowerUnit = u.toLowerCase();
  if (lowerStreet.endsWith(lowerUnit) && lowerStreet.length > lowerUnit.length) {
    const head = street.slice(0, street.length - u.length).replace(/[\s,]+$/, "");
    if (head) return { street: head, unit: u };
  }
  return { street, unit: u };
}

/**
 * "12 Oak St, Apt 2, Massapequa, NY 11758". Missing parts are skipped.
 * Accepts { line1 | address, unit, city, state, zip }.
 */
function formatAddressLine(address = {}) {
  if (!address) return "";
  const { street, unit } = splitUnit({ line1: address.line1 ?? address.address, unit: address.unit });
  const stateZip = [clean(address.state, 10), clean(address.zip, 10)].filter(Boolean).join(" ");
  return [street, unitLabel(unit), clean(address.city, 80), stateZip].filter(Boolean).join(", ");
}

/** "+16315550101" -> "(631) 555-0101". Anything that is not a US number is returned trimmed. */
function formatPhone(value) {
  const raw = clean(value, 40);
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return raw;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

module.exports = { formatAddressLine, formatPhone, splitUnit, unitLabel };
