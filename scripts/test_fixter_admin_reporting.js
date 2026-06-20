const assert = require("node:assert/strict");
const router = require("../routes/fixters");

function run() {
  const {
    bookingBlocksFixterDeletion,
    normalizeBookingStatus,
    reportingByFixter,
  } = router;

  assert.equal(normalizeBookingStatus(" No_Show "), "no-show");
  for (const status of [
    "Completed",
    "Done",
    "Cancelled",
    "Canceled",
    "Failed",
    "No-Show",
    "No Show",
  ]) {
    assert.equal(
      bookingBlocksFixterDeletion({ status }),
      false,
      status
    );
  }
  assert.equal(bookingBlocksFixterDeletion({ status: "Pending" }), true);
  assert.equal(bookingBlocksFixterDeletion({ status: "Confirmed" }), true);

  const reportingFor = reportingByFixter({
    bookings: [
      { assignedFixterId: "fixter-1", status: "Completed" },
      { assignedFixterId: "fixter-1", status: "done" },
      { assignedFixterId: "fixter-1", status: "Canceled" },
    ],
    timeOff: [
      {
        technicianId: "fixter-1",
        type: "vacation",
        startAt: new Date("2026-06-20T04:00:00Z"),
        endAt: new Date("2026-06-21T04:00:00Z"),
        allDay: true,
        reason: "Family trip",
        status: "approved",
      },
      {
        technicianId: "fixter-1",
        type: "sick",
        startAt: new Date("2026-06-10T04:00:00Z"),
        endAt: new Date("2026-06-11T04:00:00Z"),
        allDay: true,
        reason: "",
        status: "approved",
      },
      {
        technicianId: "fixter-1",
        type: "training",
        startAt: new Date("2026-06-25T04:00:00Z"),
        endAt: new Date("2026-06-26T04:00:00Z"),
        allDay: true,
        reason: "Canceled training",
        status: "canceled",
      },
    ],
    now: new Date("2026-06-20T12:00:00Z"),
  });
  const report = reportingFor("fixter-1");
  assert.equal(report.completedBookingsCount, 2);
  assert.equal(report.offDaysSummary.upcomingCount, 1);
  assert.equal(report.offDaysSummary.pastCount, 1);
  assert.equal(report.offDaysSummary.recent.length, 3);
  assert.equal(report.offDaysSummary.recent[0].status, "canceled");
  assert.equal(report.offDaysSummary.recent[1].date, "2026-06-20");
  assert.equal(report.offDaysSummary.recent[1].endDate, "2026-06-20");

  const deleteRoute = router.stack.find(
    (layer) => layer.route?.path === "/:id" && layer.route.methods.delete
  );
  assert(deleteRoute, "Admin Fixter delete route must exist");

  console.log("Fixter Admin reporting and delete safety tests passed");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
