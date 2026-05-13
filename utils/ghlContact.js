const fetch = require("node-fetch");

const BASE_URL = "https://services.leadconnectorhq.com";

function cleanPhone(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) digits = "1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return "";
}

function formatBookingDateTime(date) {
  if (!date) return "";

  return new Date(date)
    .toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .replace(",", " at");
}

function getHeaders() {
  const token = process.env.GHL_API_TOKEN;

  if (!token) {
    throw new Error("Missing GHL_API_TOKEN");
  }

  return {
    Authorization: `Bearer ${token}`,
    Version: "2021-07-28",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function createOrUpdateContact({ name, email, phone }) {
  const formattedPhone = cleanPhone(phone);

  if (!formattedPhone) {
    console.log("⚠️ Invalid phone, skipping GHL contact");
    return null;
  }

  const safeName = String(name || "").trim();
  const parts = safeName ? safeName.split(/\s+/) : [];
  const firstName = parts[0] || "Customer";
  const lastName = parts.slice(1).join(" ");

  const body = {
    firstName,
    lastName,
    email: String(email || "").trim().toLowerCase(),
    phone: formattedPhone,
    locationId: process.env.GHL_LOCATION_ID,
  };

  console.log("📤 GHL create contact request:", {
    url: `${BASE_URL}/contacts/`,
    body,
    hasToken: !!process.env.GHL_API_TOKEN,
    hasLocationId: !!process.env.GHL_LOCATION_ID,
  });

  const res = await fetch(`${BASE_URL}/contacts/`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  const text = await res.text();

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  console.log("📥 GHL create contact response:", {
    status: res.status,
    ok: res.ok,
    data,
  });

  if (!res.ok) {
    const existingContactId =
      data?.meta?.contactId ||
      data?.contact?.id ||
      data?.id ||
      data?.contactId ||
      null;

    if (
      res.status === 400 &&
      data?.message &&
      String(data.message).toLowerCase().includes("duplicated contacts") &&
      existingContactId
    ) {
      console.log(
        "ℹ️ GHL duplicate contact found, using existing contact:",
        existingContactId
      );
      return existingContactId;
    }

    console.error("❌ GHL contact create failed:", {
      status: res.status,
      data,
    });
    return null;
  }

  const contactId =
    data?.contact?.id ||
    data?.id ||
    data?.contactId ||
    data?.meta?.contactId ||
    null;

  if (!contactId) {
    console.log("⚠️ GHL contact created but no contact id returned:", data);
    return null;
  }

  return contactId;
}

async function updateContactFields(contactId, fields) {
  if (!contactId || !Array.isArray(fields) || fields.length === 0) {
    console.log("⚠️ updateContactFields skipped:", { contactId, fields });
    return false;
  }

  const body = {
    customFields: fields,
  };

  console.log("📤 GHL update contact request:", {
    url: `${BASE_URL}/contacts/${contactId}`,
    contactId,
    body,
  });

  const res = await fetch(`${BASE_URL}/contacts/${contactId}`, {
    method: "PUT",
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  const text = await res.text();

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  console.log("📥 GHL update contact response:", {
    status: res.status,
    ok: res.ok,
    data,
  });

  if (!res.ok) {
    console.error("❌ GHL update contact failed:", {
      status: res.status,
      data,
    });
    return false;
  }

  return true;
}

async function addTag(contactId, tag) {
  if (!contactId || !tag) {
    console.log("⚠️ addTag skipped:", { contactId, tag });
    return false;
  }

  console.log("📤 GHL add tag request:", { contactId, tag });

  const res = await fetch(`${BASE_URL}/contacts/${contactId}/tags`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      tags: [tag],
    }),
  });

  const text = await res.text();

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  console.log("📥 GHL add tag response:", {
    status: res.status,
    ok: res.ok,
    data,
  });

  if (!res.ok) {
    console.error("❌ GHL tag add failed:", {
      status: res.status,
      data,
    });
    return false;
  }

  console.log(`✅ Tag added in GHL: ${tag} -> ${contactId}`);
  return true;
}

async function removeTag(contactId, tag) {
  if (!contactId || !tag) {
    console.log("⚠️ removeTag skipped:", { contactId, tag });
    return false;
  }

  console.log("📤 GHL remove tag request:", { contactId, tag });

  const res = await fetch(`${BASE_URL}/contacts/${contactId}/tags`, {
    method: "DELETE",
    headers: getHeaders(),
    body: JSON.stringify({
      tags: [tag],
    }),
  });

  const text = await res.text();

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  console.log("📥 GHL remove tag response:", {
    status: res.status,
    ok: res.ok,
    data,
  });

  if (!res.ok) {
    console.error("❌ GHL tag remove failed:", {
      status: res.status,
      data,
    });
    return false;
  }

  console.log(`✅ Tag removed in GHL: ${tag} -> ${contactId}`);
  return true;
}

module.exports = {
  createOrUpdateContact,
  updateContactFields,
  formatBookingDateTime,
  addTag,
  removeTag,
};