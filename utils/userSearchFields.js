function cleanSearchValue(value, maxLength = 500) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function normalizeSearchText(value) {
  return cleanSearchValue(value, 500)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@.\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearchPhone(value) {
  const digits = cleanSearchValue(value, 80).replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

function addressSearchParts(address = {}) {
  const line1 = normalizeSearchText(address.line1);
  const city = normalizeSearchText(address.city);
  const state = normalizeSearchText(address.state);
  const zip = normalizeSearchText(address.zip);
  const county = normalizeSearchText(address.county);
  const formatted = [line1, city, [state, zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(" ");
  const tokens = [line1, city, state, zip, county]
    .join(" ")
    .split(/\s+/)
    .filter((token) => token.length >= 2);
  return [formatted, line1, city, state, zip, county, ...tokens].filter(Boolean);
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function buildUserSearchFields(user = {}) {
  const fullName = normalizeSearchText(user.name);
  const firstName = normalizeSearchText(user.firstName);
  const lastName = normalizeSearchText(user.lastName);
  const email = normalizeSearchText(user.email);
  const emailParts = email.includes("@") ? email.split("@") : [email];
  const legacyAddress = addressSearchParts({
    line1: user.address,
    city: user.city,
    state: user.state,
    zip: user.zip,
    county: user.county,
  });
  const savedAddresses = Array.isArray(user.addresses)
    ? user.addresses.flatMap(addressSearchParts)
    : [];

  return {
    names: unique([
      fullName,
      firstName,
      lastName,
      [firstName, lastName].filter(Boolean).join(" "),
      [lastName, firstName].filter(Boolean).join(" "),
    ]),
    emails: unique([email, ...emailParts]),
    phone: normalizeSearchPhone(user.phone),
    addresses: unique([...legacyAddress, ...savedAddresses]),
  };
}

module.exports = {
  addressSearchParts,
  buildUserSearchFields,
  cleanSearchValue,
  normalizeSearchPhone,
  normalizeSearchText,
};
