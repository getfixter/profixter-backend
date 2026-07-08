const CUSTOMER_EDITABLE_STATUSES = new Set(["pending", "confirmed"]);
const CUSTOMER_UPDATE_WINDOW_HOURS = 48;

function appointmentStartTime(booking) {
  const date = new Date(booking?.scheduledStart || booking?.date);
  return Number.isNaN(date.getTime()) ? null : date;
}

function canCustomerAddAppointmentDetails(booking, now = new Date()) {
  const status = String(booking?.status || "").trim().toLowerCase();
  if (!CUSTOMER_EDITABLE_STATUSES.has(status)) {
    return {
      allowed: false,
      message: "Only pending or confirmed appointments can be updated.",
    };
  }

  const start = appointmentStartTime(booking);
  if (!start) {
    return {
      allowed: false,
      message: "Appointment start time is not available.",
    };
  }

  const hoursUntil = (start.getTime() - now.getTime()) / (60 * 60 * 1000);
  if (hoursUntil <= CUSTOMER_UPDATE_WINDOW_HOURS) {
    return {
      allowed: false,
      message: "Appointment can only be updated more than 48 hours before the visit.",
    };
  }

  return { allowed: true, message: "", hoursUntil };
}

function actorSnapshot(user, roleFallback = "system") {
  if (!user) {
    return {
      actorUserId: null,
      actorName: "System",
      actorEmail: "",
      actorRole: roleFallback,
      actorPosition: "",
    };
  }

  return {
    actorUserId: user._id || null,
    actorName: user.name || user.email || "Unknown user",
    actorEmail: user.email || "",
    actorRole: user.role || roleFallback,
    actorPosition: user.employeePosition || "",
  };
}

function appendPublicNote(booking, note, { source, actorName, at = new Date() } = {}) {
  const text = String(note || "").trim();
  if (!text) return false;

  const label = source === "customer" ? "Customer added" : "Admin added";
  const stamp = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  const header = `${label}${actorName ? ` by ${actorName}` : ""} on ${stamp}:`;
  booking.note = [String(booking.note || "").trim(), `${header}\n${text}`]
    .filter(Boolean)
    .join("\n\n");
  return true;
}

function appendContentUpdate(booking, { actor, source, noteAdded = "", imagesAdded = [] }) {
  const trimmedNote = String(noteAdded || "").trim();
  const imageList = Array.isArray(imagesAdded) ? imagesAdded.filter(Boolean).map(String) : [];
  if (!trimmedNote && !imageList.length) return false;

  booking.contentUpdates = (booking.contentUpdates || []).concat({
    actorUserId: actor?.actorUserId || null,
    actorName: actor?.actorName || "",
    actorEmail: actor?.actorEmail || "",
    actorRole: actor?.actorRole || "system",
    source,
    noteAdded: trimmedNote,
    imagesAdded: imageList,
    createdAt: new Date(),
  });
  return true;
}

module.exports = {
  CUSTOMER_EDITABLE_STATUSES,
  CUSTOMER_UPDATE_WINDOW_HOURS,
  appointmentStartTime,
  canCustomerAddAppointmentDetails,
  actorSnapshot,
  appendPublicNote,
  appendContentUpdate,
};
