/**
 * When marketing SMS becomes allowed, decided by the clock and not by a person.
 *
 * WHY THIS EXISTS RATHER THAN A FLAG SOMEBODY FLIPS
 *
 * Marketing SMS was approved to begin at noon on 14 September 2026, New York
 * time, and nobody is required to be awake for it. An environment variable
 * cannot express that: it is either on or off, so "on at noon tomorrow" would
 * mean a human changing production configuration at noon tomorrow. This module
 * is the gate instead, and it needs no action from anyone.
 *
 * SMS_MARKETING_ENABLED stays TRUE alongside it, deliberately. Two gates that
 * both have to be satisfied, where one of them needs a human tomorrow, is just
 * the manual flag again wearing a costume - the flag says "marketing exists as
 * a capability", and this file is the only thing standing between now and the
 * first marketing text.
 *
 * WHY THE TIMESTAMP CARRIES ITS OWN OFFSET
 *
 * "2026-09-14T12:00:00-04:00" is a single unambiguous instant. Writing it as a
 * naive local string and converting at runtime would depend on the server's
 * timezone, and writing it as bare UTC would silently drift by an hour if the
 * date were ever moved across a DST boundary. September in New York is EDT
 * (UTC-4); the offset is stated so the value means the same thing whatever the
 * machine thinks it is, and so a future edit to a November date is forced to
 * state its own offset rather than inherit a wrong one.
 *
 * CROSSING IT SENDS NOTHING
 *
 * This answers one question - "may marketing run now" - and has no side
 * effects. Nothing is queued while it returns false, so there is nothing to
 * release when it starts returning true. The campaign runner selects its
 * audience from current eligibility at the moment it runs, so a campaign that
 * would have been due at 9am is not owed anything at noon: it simply becomes
 * selectable on the next sweep like any other. There is no backlog, no
 * catch-up pass and no "missed sends" query anywhere in the marketing path.
 */

/** The approved instant, stated with its offset. */
const DEFAULT_LAUNCH_AT = "2026-09-14T12:00:00-04:00";

/**
 * Overridable, because a date somebody chose once should not need a deploy to
 * move. An unparseable value falls back to the approved default rather than
 * failing open - a malformed string must never mean "marketing is allowed".
 */
function marketingSmsLaunchAt() {
  const raw = String(process.env.SMS_MARKETING_LAUNCH_AT || "").trim();
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
    console.warn(
      JSON.stringify({
        event: "sms_marketing_launch_at_unparseable",
        value: raw.slice(0, 40),
        using: DEFAULT_LAUNCH_AT,
      })
    );
  }
  return new Date(DEFAULT_LAUNCH_AT);
}

/** Has the launch instant passed? */
function marketingSmsLaunched(now = new Date()) {
  return now.getTime() >= marketingSmsLaunchAt().getTime();
}

/**
 * The gate, with its reasoning, for logs and the admin screen.
 *
 * Returned rather than logged here so the caller decides how loud to be; the
 * campaign sweep logs it once per run, which is what makes the transition
 * visible tomorrow without anybody watching for it.
 */
function marketingSmsLaunchState(now = new Date()) {
  const launchAt = marketingSmsLaunchAt();
  const launched = now.getTime() >= launchAt.getTime();
  return {
    launched,
    launchAt: launchAt.toISOString(),
    launchAtLocal: DEFAULT_LAUNCH_AT,
    msUntilLaunch: launched ? 0 : launchAt.getTime() - now.getTime(),
    reason: launched ? "marketing_launch_reached" : "before_marketing_launch",
  };
}

module.exports = {
  DEFAULT_LAUNCH_AT,
  marketingSmsLaunchAt,
  marketingSmsLaunchState,
  marketingSmsLaunched,
};
