/**
 * The Recent Work lifecycle, in one place.
 *
 * ONE STATUS FIELD, NOT A BAG OF BOOLEANS.
 *
 * The obvious alternative - approved/published/pending flags - produces
 * combinations nobody can read six months later. What does approved=false,
 * published=true, pending=false mean? It means somebody wrote three
 * independent writes and one of them lost a race. So there is exactly one
 * authoritative field, every value is a sentence, and the timestamps beside it
 * are history rather than state.
 *
 * The distinction between "never published" and "published then withdrawn" is
 * deliberately NOT a status. Both are LIBRARY - the photo is ours, retained,
 * and not public - and which one it is reads off firstPublishedAt. Making them
 * separate states would mean every publish path had to know which one to return
 * to, for no gain.
 */

const STATUS = Object.freeze({
  /** A member submitted it. It is invisible to the public until an admin acts. */
  PENDING_REVIEW: "pending_review",
  /** A Fixter uploaded it. It publishes itself at publishAt unless cancelled. */
  SCHEDULED: "scheduled",
  /** Public. This is the ONLY status the public API will ever serve. */
  PUBLISHED: "published",
  /** Ours, retained, not public. Either never published or withdrawn. */
  LIBRARY: "library",
  /** A member submission an admin refused. Never public, never auto-retried. */
  REJECTED: "rejected",
  /** Deleted: the image bytes are gone, this row is the tombstone. */
  ARCHIVED: "archived",
});

const ALL_STATUSES = Object.freeze(Object.values(STATUS));

/** Who put it there. Decides which lifecycle the upload enters. */
const UPLOADER_TYPE = Object.freeze({
  ADMIN: "admin",
  FIXTER: "fixter",
  MEMBER: "member",
});

const ALL_UPLOADER_TYPES = Object.freeze(Object.values(UPLOADER_TYPE));

/**
 * How long a Fixter's upload waits before it publishes itself.
 *
 * The window exists so somebody who uploaded the wrong photo can take it back
 * without needing an admin. It is not a review period - nobody is required to
 * look - so it is short enough not to feel like one.
 */
const FIXTER_PUBLISH_DELAY_MS = 5 * 60 * 1000;

/**
 * The categories a photo can carry.
 *
 * Deliberately the service slugs the marketing site already uses rather than a
 * new vocabulary, so the eventual public gallery can link a photo straight to
 * the service page that sells that work. A second, prettier list invented here
 * would have to be mapped to those slugs by hand forever.
 */
const CATEGORIES = Object.freeze([
  { slug: "general-handyman", label: "General Handyman" },
  { slug: "tv-mounting", label: "TV Mounting" },
  { slug: "drywall-repair", label: "Drywall Repair" },
  { slug: "door-repair", label: "Door Repair" },
  { slug: "light-fixture-installation", label: "Light Fixtures" },
  { slug: "furniture-assembly", label: "Furniture Assembly" },
  { slug: "caulking", label: "Caulking & Sealing" },
  { slug: "bathroom-remodeling", label: "Bathroom" },
  { slug: "kitchen-remodeling", label: "Kitchen" },
  { slug: "roofing", label: "Roofing" },
  { slug: "siding", label: "Siding" },
  { slug: "full-home-renovation", label: "Full Renovation" },
  { slug: "other", label: "Other" },
]);

const CATEGORY_SLUGS = Object.freeze(CATEGORIES.map((c) => c.slug));

function isValidCategory(slug) {
  return CATEGORY_SLUGS.includes(String(slug || ""));
}

/**
 * Which status an upload starts in, by who uploaded it.
 *
 * The three rules the product is built on, expressed once:
 *   admin   - trusted, publishes immediately if they asked for it
 *   fixter  - trusted, but never instantly; the delay is the safety net
 *   member  - never trusted to publish; a human decides
 */
function initialStatusFor(uploaderType, { publishNow = false } = {}) {
  if (uploaderType === UPLOADER_TYPE.ADMIN) {
    return publishNow ? STATUS.PUBLISHED : STATUS.LIBRARY;
  }
  if (uploaderType === UPLOADER_TYPE.FIXTER) return STATUS.SCHEDULED;
  if (uploaderType === UPLOADER_TYPE.MEMBER) return STATUS.PENDING_REVIEW;
  throw new Error(`Unknown uploader type: ${uploaderType}`);
}

/**
 * The single predicate for "may the public see this".
 *
 * Deliberately one comparison. Anything more - a date check, an OR, a
 * not-deleted clause bolted on at the call site - is a place for a mistake to
 * hide, and the mistake would be publishing a customer's kitchen without their
 * say-so. SCHEDULED is not public: the worker promotes it to PUBLISHED when its
 * time comes, and until then the answer is simply no.
 */
function isPubliclyVisible(photo) {
  return photo?.status === STATUS.PUBLISHED;
}

/**
 * Legal transitions. Anything not listed here is refused by the service layer.
 *
 * REJECTED can go back to PUBLISHED because an admin who refuses a photo by
 * mistake should not have to ask the member to send it again. ARCHIVED is
 * terminal: the bytes are gone, so there is nothing left to publish.
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  [STATUS.PENDING_REVIEW]: [STATUS.PUBLISHED, STATUS.LIBRARY, STATUS.REJECTED, STATUS.ARCHIVED],
  [STATUS.SCHEDULED]: [STATUS.PUBLISHED, STATUS.LIBRARY, STATUS.ARCHIVED],
  [STATUS.PUBLISHED]: [STATUS.LIBRARY, STATUS.ARCHIVED],
  [STATUS.LIBRARY]: [STATUS.PUBLISHED, STATUS.ARCHIVED],
  [STATUS.REJECTED]: [STATUS.PUBLISHED, STATUS.LIBRARY, STATUS.ARCHIVED],
  [STATUS.ARCHIVED]: [],
});

function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

module.exports = {
  ALLOWED_TRANSITIONS,
  ALL_STATUSES,
  ALL_UPLOADER_TYPES,
  CATEGORIES,
  CATEGORY_SLUGS,
  FIXTER_PUBLISH_DELAY_MS,
  STATUS,
  UPLOADER_TYPE,
  canTransition,
  initialStatusFor,
  isPubliclyVisible,
  isValidCategory,
};
