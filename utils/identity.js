function normalizeEmail(email) {
  const v = String(email || "").trim().toLowerCase();
  return v || null;
}

function extractUSNationalPhoneDigits(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;

  if (digits.startsWith("001")) {
    digits = digits.slice(2);
  }

  while (digits.length > 10 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }

  if (digits.length !== 10) return null;

  // North American numbering plan: area code and central office cannot start 0/1.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;

  return digits;
}

function normalizePhone(phone) {
  const national = extractUSNationalPhoneDigits(phone);
  return national ? `1${national}` : null;
}

function normalizePhoneE164(phone) {
  const normalized = normalizePhone(phone);
  return normalized ? `+${normalized}` : null;
}

function digitsOnlyPhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

module.exports = {
  normalizeEmail,
  normalizePhone,
  normalizePhoneE164,
  extractUSNationalPhoneDigits,
  digitsOnlyPhone,
};
