/**
 * Who may open which part of Admin - the one place that says so.
 *
 * THE MODEL
 * - The owner (MAIL_ADMIN, or an account whose role is "admin") has every
 *   permission, including ones added later. Nothing here can restrict them.
 * - Everyone else on staff is an employee. An employee's access is the union of:
 *     1. their field work, if any (employeePosition "Fixter" / "General Fixter")
 *        - exactly the access those positions had before this registry existed,
 *        so existing Fixters keep what they had and nothing more; and
 *     2. the Admin sections the owner switched on for them (User.adminSections).
 * - The title an employee carries (User.employeeTitle) is display only. It
 *   never grants anything.
 *
 * SECTIONS are what the owner toggles. Each one lists the permissions it
 * grants; routes check permissions, not sections, so a section can be split or
 * merged later without touching a route. Users store section ids, and their
 * permissions are computed from this file on every request: an edit takes
 * effect on the employee's next request, and a section added later is OFF for
 * every existing employee until the owner turns it on.
 *
 * Some things are deliberately never grantable (owner only): managing
 * employees (whoever can do that can grant themselves everything), system
 * settings, repair and debug tools, deleting customer accounts.
 */

const PERMISSIONS = Object.freeze({
  /* The owner's own key. Never part of any section or position. */
  ADMIN: "admin.all",

  ANALYTICS_READ: "analytics.read",
  ANALYTICS_MAP: "analytics.map",

  BOOKINGS_READ: "bookings.read",
  BOOKINGS_WRITE: "bookings.write",
  BOOKINGS_ASSIGN: "bookings.assign",

  /* Read the membership list and a customer's activity timeline. */
  MEMBERS_READ: "members.read",

  SCHEDULE_READ: "schedule.read",
  SCHEDULE_WRITE: "schedule.write",

  /**
   * Read tips. Held by every Fixter, because a Fixter seeing what they earned
   * is the point of the feature. The route still scopes the query to the
   * caller: this says "may look at tips", not "may look at everyone's".
   */
  TIPS_READ: "tips.read",

  /* Customer accounts: contact details, addresses, plans, SMS consent, edits. */
  CUSTOMERS_MANAGE: "customers.manage",
  LEADS_MANAGE: "leads.manage",
  PROJECTS_MANAGE: "projects.manage",
  COMMUNICATIONS_MANAGE: "communications.manage",
  RECENT_WORK_MANAGE: "recentWork.manage",
  PROMOTION_MANAGE: "promotion.manage",
  BLACKLIST_MANAGE: "blacklist.manage",
  ACTIVITY_READ: "activity.read",
});

/*
 * Field work: the two positions that existed before custom access. Their
 * permission lists are copied unchanged from the old permissionsForUser().
 */
const POSITIONS = Object.freeze({
  Fixter: Object.freeze([PERMISSIONS.BOOKINGS_READ, PERMISSIONS.BOOKINGS_WRITE, PERMISSIONS.TIPS_READ]),
  "General Fixter": Object.freeze([
    PERMISSIONS.BOOKINGS_READ,
    PERMISSIONS.BOOKINGS_WRITE,
    PERMISSIONS.BOOKINGS_ASSIGN,
    PERMISSIONS.MEMBERS_READ,
    PERMISSIONS.SCHEDULE_READ,
    PERMISSIONS.SCHEDULE_WRITE,
    PERMISSIONS.TIPS_READ,
  ]),
});

const GROUPS = Object.freeze([
  { id: "business", label: "Business" },
  { id: "operations", label: "Operations" },
  { id: "marketing", label: "Website & Marketing" },
  { id: "administration", label: "Administration" },
]);

/*
 * The grantable Admin sections, in the order the owner sees them.
 *
 * To add a section: add it here with the permissions it needs, guard its
 * routes with those permissions, and give its tab the same `permission` in
 * the frontend's admin-tabs-config.ts. Existing employees will not have it.
 */
const SECTIONS = Object.freeze([
  {
    id: "overview",
    group: "business",
    label: "Overview",
    description: "Business performance: members, revenue, acquisition and funnels",
    permissions: [PERMISSIONS.ANALYTICS_READ],
  },
  {
    id: "customer-map",
    group: "business",
    label: "Customer Map",
    description: "Customer locations on the Overview map",
    permissions: [PERMISSIONS.ANALYTICS_MAP],
    requires: "overview",
  },
  {
    id: "members",
    group: "business",
    label: "Members",
    description: "The list of active memberships (view only)",
    permissions: [PERMISSIONS.MEMBERS_READ],
  },
  {
    id: "customers",
    group: "business",
    label: "All Users",
    description: "Customer accounts, contact details and plans; can edit them",
    permissions: [PERMISSIONS.CUSTOMERS_MANAGE, PERMISSIONS.MEMBERS_READ],
  },
  {
    id: "leads",
    group: "business",
    label: "Leads",
    description: "Estimate requests from the website",
    permissions: [PERMISSIONS.LEADS_MANAGE],
  },
  {
    id: "projects",
    group: "business",
    label: "Projects",
    description: "Projects, estimates, contracts, change orders and invoices",
    permissions: [PERMISSIONS.PROJECTS_MANAGE],
  },
  {
    id: "jobs",
    group: "operations",
    label: "Jobs",
    description: "All bookings: view, update and assign Fixters",
    permissions: [PERMISSIONS.BOOKINGS_READ, PERMISSIONS.BOOKINGS_WRITE, PERMISSIONS.BOOKINGS_ASSIGN],
  },
  {
    id: "schedule",
    group: "operations",
    label: "Schedule",
    description: "Working hours, days off and calendar capacity",
    permissions: [PERMISSIONS.SCHEDULE_READ, PERMISSIONS.SCHEDULE_WRITE],
  },
  {
    id: "recent-work",
    group: "marketing",
    label: "Recent Work / Photos",
    description: "Website work photos: upload, edit, publish and remove",
    permissions: [PERMISSIONS.RECENT_WORK_MANAGE],
  },
  {
    id: "communications",
    group: "marketing",
    label: "Communications",
    description: "Email & SMS templates, campaigns and message history",
    permissions: [PERMISSIONS.COMMUNICATIONS_MANAGE],
  },
  {
    id: "promotion",
    group: "marketing",
    label: "Promotion Popup",
    description: "The visitor promotion on the website",
    permissions: [PERMISSIONS.PROMOTION_MANAGE],
  },
  {
    id: "blacklist",
    group: "administration",
    label: "Blacklist",
    description: "Block and unblock customer accounts",
    permissions: [PERMISSIONS.BLACKLIST_MANAGE],
  },
  {
    id: "activity",
    group: "administration",
    label: "Activity Log",
    description: "The record of changes made in Admin",
    permissions: [PERMISSIONS.ACTIVITY_READ],
  },
]);

const SECTION_BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));

/** Keep only known section ids, once each, and drop a section whose prerequisite is off. */
function cleanSections(input) {
  const ids = new Set((Array.isArray(input) ? input : []).map(String).filter((id) => SECTION_BY_ID.has(id)));
  for (const id of [...ids]) {
    const req = SECTION_BY_ID.get(id).requires;
    if (req && !ids.has(req)) ids.delete(id);
  }
  return SECTIONS.map((s) => s.id).filter((id) => ids.has(id));
}

function permissionsForSections(sectionIds) {
  const out = new Set();
  for (const id of cleanSections(sectionIds)) for (const p of SECTION_BY_ID.get(id).permissions) out.add(p);
  return out;
}

function positionPermissions(position) {
  return POSITIONS[position] ? [...POSITIONS[position]] : [];
}

function isFieldPosition(position) {
  return Object.prototype.hasOwnProperty.call(POSITIONS, position || "");
}

/** The registry the owner's access editor renders. No permission ids leave this function. */
function registryForEditor() {
  /* A section a field-work type already fully covers is shown as included, not as a switch. */
  const includedByPosition = Object.fromEntries(
    Object.entries(POSITIONS).map(([position, perms]) => [
      position,
      SECTIONS.filter((s) => s.permissions.every((p) => perms.includes(p))).map((s) => s.id),
    ])
  );
  return {
    groups: GROUPS.map((g) => ({ ...g })),
    sections: SECTIONS.map(({ id, group, label, description, requires }) => ({ id, group, label, description, requires: requires || null })),
    positions: Object.keys(POSITIONS),
    includedByPosition,
  };
}

module.exports = {
  PERMISSIONS,
  POSITIONS,
  GROUPS,
  SECTIONS,
  cleanSections,
  permissionsForSections,
  positionPermissions,
  isFieldPosition,
  registryForEditor,
};
