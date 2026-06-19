const BookingHistory = require("../models/BookingHistory");

const TRACKED_FIELDS = [
  ["status", "Status"],
  ["date", "Time"],
  ["service", "Service"],
  ["address", "Address"],
  ["note", "Notes"],
  ["assignedFixterId", "Assigned Fixter"],
];

function readable(value, field, source = {}) {
  if (field === "assignedFixterId") {
    return String(source.assignedFixterName || "").trim() || "Unassigned";
  }
  if (field === "date") {
    if (!value) return "Not set";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  const text = String(value ?? "").trim();
  return text || (field === "note" ? "No notes" : "Not set");
}

function snapshot(booking) {
  const source = booking?.toObject ? booking.toObject() : booking || {};
  return {
    status: source.status,
    date: source.date,
    service: source.service,
    address: source.address,
    note: source.note,
    assignedFixterId: source.assignedFixterId
      ? String(source.assignedFixterId)
      : "",
    assignedFixterName: source.assignedFixterName || "",
  };
}

function detectChanges(before, after) {
  return TRACKED_FIELDS.flatMap(([field, label]) => {
    const oldComparable =
      field === "date"
        ? new Date(before[field] || 0).getTime()
        : String(before[field] ?? "");
    const newComparable =
      field === "date"
        ? new Date(after[field] || 0).getTime()
        : String(after[field] ?? "");
    if (oldComparable === newComparable) return [];
    return [{
      field,
      label,
      oldValue: readable(before[field], field, before),
      newValue: readable(after[field], field, after),
    }];
  });
}

function actorFromRequest(req) {
  const user = req?.accessUser || req?.authUser;
  if (!user) {
    return {
      actorUserId: null,
      actorName: "System",
      actorEmail: "",
      actorRole: "system",
      actorPosition: "",
    };
  }
  return {
    actorUserId: user._id,
    actorName: user.name || user.email || "Unknown user",
    actorEmail: user.email || "",
    actorRole: req.accessRole || user.role || "customer",
    actorPosition: user.employeePosition || "",
  };
}

function actionForChanges(changes) {
  const fields = new Set(changes.map((change) => change.field));
  const statusChange = changes.find((change) => change.field === "status");
  if (statusChange?.newValue === "Confirmed") {
    return ["booking_confirmed", "Booking confirmed"];
  }
  if (statusChange?.newValue === "Canceled") {
    return ["booking_canceled", "Booking canceled"];
  }
  if (fields.size === 1 && fields.has("status")) {
    return ["status_changed", "Status changed"];
  }
  if (fields.size === 1 && fields.has("assignedFixterId")) {
    return ["assigned_fixter_changed", "Assigned Fixter changed"];
  }
  if (
    fields.size === 1 &&
    fields.has("note") &&
    changes[0].oldValue === "No notes"
  ) {
    return ["note_added", "Note added"];
  }
  return ["booking_edited", "Booking edited"];
}

async function logBookingChanges({ bookingId, before, after, req }) {
  const changes = detectChanges(before, after);
  if (!changes.length) return null;
  const [actionType, summary] = actionForChanges(changes);
  return BookingHistory.create({
    bookingId,
    ...actorFromRequest(req),
    actionType,
    changes,
    summary,
  });
}

async function logBookingCreated({ booking, req, actorName }) {
  const actor = actorName
    ? {
        actorUserId: null,
        actorName,
        actorEmail: "",
        actorRole: "system",
        actorPosition: "",
      }
    : actorFromRequest(req);
  return BookingHistory.create({
    bookingId: booking._id,
    ...actor,
    actionType: "booking_created",
    changes: [],
    summary: "Booking created",
  });
}

module.exports = {
  snapshot,
  detectChanges,
  logBookingChanges,
  logBookingCreated,
};
