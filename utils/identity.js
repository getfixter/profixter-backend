function normalizeEmail(email) {
  const v = String(email || "").trim().toLowerCase();
  return v || null;
}

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;

  // US handling
  if (digits.length === 10) return "1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits;

  // fallback for non-standard input
  return digits;
}

function digitsOnlyPhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

module.exports = {
  normalizeEmail,
  normalizePhone,
  digitsOnlyPhone,
};