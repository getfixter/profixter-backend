/**
 * The marketing email library.
 *
 * Each entry is data, not code: who it is for, what it is about, when it is
 * allowed, and the copy. The scheduler picks from this rather than running down
 * a switch statement, so adding a message is adding a row.
 *
 * Ids carry a version. When copy is rewritten meaningfully the version goes up,
 * and history stays readable because `nonmember_free_visit_v1` and `_v2` are
 * different campaigns that a person can each receive.
 *
 * The copy rule throughout: name something concrete the reader can picture in
 * their own house. "That door that never closes quite right" earns attention in
 * a way that "quality home services" does not. No urgency, no discounts we do
 * not have, no claims about services we do not perform. American English: this
 * is a Long Island company.
 */

/* Categories, used to keep consecutive emails from feeling alike. */
const CATEGORY = {
  FREE_VISIT: "free_visit",
  /* After the free visit, before the membership. See TRACK B below. */
  POST_FREE_VISIT: "post_free_visit",
  MEMBERSHIP: "membership",
  ANNUAL: "annual",
  ONE_TIME: "one_time",
  FULL_DAY: "full_day",
  PROJECT: "project",
  FIX: "fix",
  TRUST: "trust",
  REFERRAL: "referral",
  ACTIVATION: "activation",
  USAGE: "usage",
  UPGRADE: "upgrade",
  REINTRO: "reintro",
  GIFT: "gift",
};

/**
 * What a campaign is trying to do.
 *
 * "help" gives the reader something useful whether or not they ever buy again.
 * "sell" asks them to spend money. The scheduler steers the long run mix toward
 * mostly help, which priority alone could not achieve.
 */
const KIND = { HELP: "help", SELL: "sell" };

/**
 * Higher wins when several messages are eligible on the same day.
 *
 * Above 80 bypasses the softer per audience rotation pace, because activation,
 * the opening lifecycle and a first reintroduction are the three things that
 * have to land at a particular moment to mean anything.
 */
const PRIORITY = {
  ACTIVATION: 100,
  /*
   * Above the lifecycle on purpose. An account that registered ten months ago
   * and has never heard from us is about to receive the opening sequence, and
   * saying hello should come before "your first visit is free". It can only
   * fire once, for accounts over 90 days old with no history at all.
   */
  REINTRO: 85,
  /*
   * Above the opening lifecycle, below a first hello.
   *
   * Somebody who had a Fixter in their house last week is in a different
   * conversation from somebody who signed up and never booked, and the
   * post-visit sequence has to win that comparison. Without its own tier
   * both sat on LIFECYCLE and the tiebreak - lowest scheduled day - handed
   * the slot to whichever generic campaign happened to have a low day
   * number, because a day counted from registration and a day counted from
   * the visit are not the same measurement and must not be compared.
   */
  POST_FREE_VISIT: 82,
  LIFECYCLE: 80,
  /*
   * All ordinary rotation content sits on one tier, helpful and commercial
   * alike. Giving helpful campaigns a higher priority looked right and was
   * wrong: priority is compared before anything else, so help beat sell every
   * single time and the member mix went to 94% helpful, which is not a balance
   * either. Which one a person gets is decided by the help steer in the
   * scheduler, which measures their recent mix and aims at HELP_TARGET.
   */
  ROTATION: 30,
};

/**
 * Where a "book something" button should point, per audience.
 *
 * The same home fix email is useful to a member, a non member and somebody who
 * cancelled last year, but they should not all land on the same page. A member
 * books against their membership; everybody else books a single visit.
 */
const BOOK_ROUTES = {
  non_member: "book",
  member: "bookMembership",
  former_member: "bookOneTime",
};

/** A campaign may serve more than one audience. */
function audiencesOf(template) {
  return Array.isArray(template.audience) ? template.audience : [template.audience];
}

/** Resolve the call to action for a given reader. */
function ctaFor(template, audience) {
  const route =
    (template.ctaRouteByAudience && template.ctaRouteByAudience[audience]) || template.ctaRoute;
  const label =
    (template.ctaLabelByAudience && template.ctaLabelByAudience[audience]) || template.ctaLabel;
  return { label, route };
}

const EVERYONE = ["non_member", "member", "former_member"];

/* ------------------------------------------------------------------ */
/* The specific home fix library                                       */
/* ------------------------------------------------------------------ */

/*
 * The heart of the system, and the only content that is true for anybody with
 * a house. It now serves all three audiences rather than just non members:
 * a member wondering what to use their visit on is exactly the person who
 * should be reading about the door that sticks. That change is also what makes
 * the mostly helpful member ratio achievable, since there was not enough member
 * specific usage content to reach it on its own.
 */
const FIX_LIBRARY = [
  {
    id: "fix_faucets_v1", topic: "faucets",
    subject: "The faucet that has been dripping since spring",
    altSubject: "The drip you have stopped hearing",
    preheader: "Drips, loose handles, tired fixtures.",
    headline: "The drip you have stopped hearing",
    paragraphs: [
      "Next time you are at the kitchen sink, take a good look.",
      "A drip that started months ago, a handle gone loose, a fixture that has had its day. None of it gets better on its own.",
    ],
    ctaLabel: "Get the drip fixed",
  },
  {
    id: "fix_lights_v1", topic: "lights",
    subject: "The light nobody has replaced yet",
    altSubject: "The bulb is not always the problem",
    preheader: "Fixtures, replacements, and the one that flickers.",
    headline: "The light nobody has replaced yet",
    paragraphs: [
      "Most homes have at least one light that has been odd for a while, or a fixture that never got replaced.",
      "A Fixter can swap fixtures and get things working properly again.",
    ],
    ctaLabel: "Get the light replaced",
  },
  {
    id: "fix_doors_v1", topic: "doors",
    subject: "That door that never closes quite right",
    altSubject: "The door you shove with your hip",
    preheader: "Sticking, rubbing, loose handles, hinges.",
    headline: "That door that never closes quite right",
    paragraphs: [
      "You know the one. It sticks, or it rubs the frame, or the handle has gone loose and you have learned to work around it.",
      "It is usually a quick job.",
    ],
    ctaLabel: "Get the door fixed",
  },
  {
    id: "fix_mounting_v1", topic: "mounting",
    subject: "It is still leaning against the wall",
    altSubject: "The TV that never went up",
    preheader: "TVs, shelves, mirrors, artwork, curtain rails.",
    headline: "It is still leaning against the wall",
    paragraphs: [
      "The TV, the mirror, the picture that has been leaning against the wall since you moved in.",
      "Mounting is one of the most common things we get asked for, and one of the quickest to handle.",
    ],
    ctaLabel: "Get it on the wall",
  },
  {
    id: "fix_bathroom_v1", topic: "bathroom",
    subject: "Small bathroom jobs do not stay small",
    altSubject: "The caulk you keep meaning to redo",
    preheader: "Caulk, hardware, loose fixtures, accessories.",
    headline: "Small bathroom jobs do not stay small",
    paragraphs: [
      "Tired caulk, a loose towel bar, a fixture that wobbles, a hook that came away from the wall.",
      "Worth handling while they are still small jobs.",
    ],
    ctaLabel: "Book the bathroom jobs",
  },
  {
    id: "fix_kitchen_v1", topic: "kitchen",
    subject: "The cabinet door that never sits right",
    altSubject: "Cabinet doors and loose handles",
    preheader: "Cabinet hardware, doors, shelves, adjustments.",
    headline: "The cabinet door that never sits right",
    paragraphs: [
      "Cabinet doors drift out of alignment, handles work loose, shelves sag.",
      "Individually tiny. Together they make a kitchen feel older than it is.",
    ],
    ctaLabel: "Get the cabinets aligned",
  },
  {
    id: "fix_walls_v1", topic: "walls",
    subject: "The holes from the last thing you took down",
    altSubject: "Small wall damage",
    preheader: "Patching, small drywall repair, touch-ups.",
    headline: "The holes from the last thing you took down",
    paragraphs: [
      "Anchor holes, a dent from moving furniture, the patch that never got painted.",
      "Quick to fix, and the room looks finished again.",
    ],
    ctaLabel: "Get the walls patched",
  },
  {
    id: "fix_hardware_v1", topic: "hardware",
    subject: "Loose handles and little things add up",
    altSubject: "Everything that wobbles",
    preheader: "Handles, pulls, hinges, hooks, towel bars.",
    headline: "Loose handles and little things add up",
    paragraphs: [
      "No single loose handle is worth a phone call. Fifteen of them is a different matter.",
      "A Fixter can go around the house tightening, replacing and adjusting in one visit.",
    ],
    ctaLabel: "Tighten everything up",
  },
  {
    id: "fix_shelving_v1", topic: "shelving",
    subject: "The shelf that was never put up",
    altSubject: "Closets, garages and that awkward wall",
    preheader: "Shelving and wall-mounted organization.",
    headline: "The shelf that was never put up",
    paragraphs: [
      "Most storage problems are really a shelf that was never put up.",
      "Closets, garages, laundry rooms, that awkward wall in the hallway.",
    ],
    ctaLabel: "Get the shelves up",
  },
  {
    id: "fix_before_guests_v1", topic: "before_guests",
    subject: "People are coming over",
    altSubject: "The things you notice when guests are due",
    preheader: "The jobs you only see through someone else's eyes.",
    headline: "People are coming over",
    paragraphs: [
      "Nothing makes you notice your own house like knowing somebody else is about to see it.",
      "The patch on the wall, the door that sticks, the light that never got replaced.",
    ],
    ctaLabel: "Book before they arrive",
  },
  {
    id: "fix_new_home_v1", topic: "new_home",
    subject: "The boxes are gone. The list is not.",
    altSubject: "Moved in and still not finished",
    preheader: "Mounting, shelves, hardware and the rest of the setup.",
    headline: "The boxes are gone. The list is not.",
    paragraphs: [
      "Getting the boxes out is the easy part. It is the mounting, the shelves and the hardware that drag on for months.",
      "One visit usually clears most of it.",
    ],
    ctaLabel: "Finish the setup",
  },
  {
    id: "fix_one_room_v1", topic: "one_room",
    subject: "Pick one room",
    altSubject: "Start with the worst room",
    preheader: "One room, one visit, properly finished.",
    headline: "Pick one room",
    paragraphs: [
      "If the whole-house list feels like too much, pick the room that annoys you most and have a Fixter finish it properly.",
      "It is a surprisingly good way to start.",
    ],
    ctaLabel: "Pick a room and book",
  },
].map((fix) => ({
  ...fix,
  audience: EVERYONE,
  category: CATEGORY.FIX,
  kind: KIND.HELP,
  priority: PRIORITY.ROTATION,
  ctaRouteByAudience: BOOK_ROUTES,
  ctaRoute: "book",
}));

/* ------------------------------------------------------------------ */
/* First contact                                                       */
/* ------------------------------------------------------------------ */

/*
 * For accounts that predate marketing entirely.
 *
 * Roughly 100 of the current customer base registered months ago and has never
 * received a marketing email. Dropping them into the middle of the rotation
 * means the first thing they hear from us in eight months is a note about
 * faucets. These three say hello first, once, and then hand over to the normal
 * rotation. None of them apologise for the silence, because pointing at it is
 * worse than the silence was.
 */
const FIRST_CONTACT = [
  {
    id: "reintro_non_member_v1",
    audience: "non_member", category: CATEGORY.REINTRO, topic: "reintro",
    kind: KIND.HELP, priority: PRIORITY.REINTRO, firstContactOnly: true,
    subject: "A quick note from ProFixter",
    altSubject: "What we can take off your list",
    preheader: "Who we are and what we handle around the house.",
    headline: "A quick note from ProFixter",
    paragraphs: [
      ({ name }) => `Hi ${name}, you set up a ProFixter account a while back, so here is a short reminder of what we do.`,
      "We are a Long Island handyman company. Licensed, insured, working across Nassau and Suffolk.",
      "Mounting, doors, faucets, lights, patching, shelving, hardware. The jobs that are too small to feel worth a phone call and too annoying to leave.",
      "Book a single visit whenever you want one, or take a membership and have someone coming regularly.",
    ],
    ctaLabel: "See what we handle", ctaRoute: "services",
    closing: "We will send you an occasional note about the kind of thing worth fixing. Nothing more than that.",
  },
  {
    id: "reintro_member_v1",
    audience: "member", category: CATEGORY.REINTRO, topic: "reintro",
    kind: KIND.HELP, priority: PRIORITY.REINTRO, firstContactOnly: true,
    subject: "Making your membership easier to use",
    altSubject: "A reminder of what your Fixter can do",
    preheader: "Ideas for your next visit, and nothing to buy.",
    headline: "Making your membership easier to use",
    paragraphs: [
      ({ name }) => `Hi ${name}, thanks for being a ProFixter member.`,
      "We are going to start sending an occasional note with ideas for what to use your visits on, because the hardest part of having a Fixter is remembering what you wanted done.",
      "A few things members book most often:",
    ],
    bullets: [
      "Mounting a TV, mirror or shelves",
      "A door that sticks or will not latch",
      "Replacing a tired light fixture",
      "A dripping faucet",
      "Going around tightening everything that has worked loose",
    ],
    ctaLabel: "Book your next visit", ctaRoute: "bookMembership",
    closing: "One email every few weeks. You can stop them at any time and it will not affect your bookings.",
  },
  {
    id: "reintro_former_member_v1",
    audience: "former_member", category: CATEGORY.REINTRO, topic: "reintro",
    kind: KIND.HELP, priority: PRIORITY.REINTRO, firstContactOnly: true,
    subject: "Your ProFixter account is still here",
    altSubject: "No membership needed",
    preheader: "You can still book a Fixter whenever you need one.",
    headline: "Your ProFixter account is still here",
    paragraphs: [
      ({ name }) => `Hi ${name}, your ProFixter account is still active even though your membership ended.`,
      "You can book a single visit any time you need one. Same Fixters, same work, no membership required.",
      "We will send you an occasional note about the kind of thing worth fixing around the house. That is all.",
    ],
    ctaLabel: "Book a single visit", ctaRoute: "bookOneTime",
  },
];

/* ------------------------------------------------------------------ */
/* Non member lifecycle: the ordered opening sequence                  */
/* ------------------------------------------------------------------ */

/*
 * TRACK A - four emails with one job: get the Free First Visit used.
 *
 * The previous opening was two generic campaigns that happened to mention
 * the offer. It went to thirty-seven people and produced no bookings at all,
 * which is a clear enough verdict on copy that asks somebody to "book a
 * visit" without telling them what they already have.
 *
 * So all four say the same four facts, in different words and from different
 * angles: you have a free visit, it covers one job, labor and the trip are
 * included, and you do not have to join anything to use it. Membership is
 * mentioned once, in passing, at the end - selling a subscription to somebody
 * who has never met us is asking for the second decision before the first.
 *
 * The sequence ends. Day 45 says so and the eligibility rules enforce it.
 */
const NON_MEMBER_LIFECYCLE = [
  {
    id: "nonmember_free_visit_v2",
    audience: "non_member", category: CATEGORY.FREE_VISIT, topic: "free_visit",
    kind: KIND.HELP, lifecycleDay: 2, priority: PRIORITY.LIFECYCLE,
    requiresFreeVisitEligible: true,
    subject: "Your first visit is free - pick one job",
    altSubject: "There is a free visit on your account",
    preheader: "One job, labor and trip included, no membership needed.",
    headline: "Your first visit is free",
    paragraphs: [
      ({ name }) => `Hi ${name}, thanks for setting up your account. There is a free first visit on it.`,
      "It covers one job. A Fixter comes out, does the work, and that is the visit - labor and the trip are included.",
      "You do not need a membership to use it. It is there so you can see how we work before deciding whether you want us again.",
      "Most people pick the thing they walk past every day and have stopped noticing.",
    ],
    ctaLabel: "Book your free visit", ctaRoute: "book",
    closing: "Booking takes about a minute.",
  },
  {
    id: "nonmember_free_visit_ideas_v1",
    audience: "non_member", category: CATEGORY.FREE_VISIT, topic: "free_visit_ideas",
    kind: KIND.HELP, lifecycleDay: 9, priority: PRIORITY.LIFECYCLE,
    requiresFreeVisitEligible: true,
    subject: "Not sure what to use the free visit on?",
    altSubject: "Ideas for your free visit",
    preheader: "It only has to be one job. Here are the usual ones.",
    headline: "Not sure what to use it on?",
    paragraphs: [
      "Your free first visit is still unused. The most common reason people leave it is not knowing whether their job counts.",
      "It almost certainly does. One job, and these are the ones we get asked for most:",
    ],
    bullets: [
      "A TV or mirror still waiting to go up",
      "A door that sticks or will not latch",
      "A dripping faucet",
      "A light fixture that needs replacing",
      "Shelves that never got hung",
      "Loose handles and hardware",
    ],
    ctaLabel: "Book your free visit", ctaRoute: "book",
    closing: "Labor and the trip are included. Pick one and we will handle it.",
  },
  {
    id: "nonmember_free_visit_still_yours_v1",
    audience: "non_member", category: CATEGORY.FREE_VISIT, topic: "free_visit_unclaimed",
    kind: KIND.HELP, lifecycleDay: 21, priority: PRIORITY.LIFECYCLE,
    requiresFreeVisitEligible: true,
    subject: "Still unclaimed: your free first visit",
    altSubject: "The free visit has not been used",
    preheader: "Available now. One job, labor and trip included.",
    headline: "It is still sitting there",
    paragraphs: [
      ({ name }) => `Hi ${name}, the free first visit on your account has not been used yet.`,
      /*
       * "Available now", not "no deadline". The offer is a current fact about
       * the account, and writing it as a permanent one is a promise nobody
       * decided to make and the product does not enforce.
       */
      "It is available now. One job, labor and the trip included, and you are under no obligation afterwards.",
      "We are a Long Island handyman company - in-house Fixters, licensed and insured, working across Nassau and Suffolk. The free visit is the easiest way to find out whether we are any good.",
    ],
    ctaLabel: "Book your free visit", ctaRoute: "book",
  },
  {
    id: "nonmember_free_visit_final_v1",
    audience: "non_member", category: CATEGORY.FREE_VISIT, topic: "free_visit_final",
    kind: KIND.HELP, lifecycleDay: 45, priority: PRIORITY.LIFECYCLE,
    requiresFreeVisitEligible: true,
    /* The one campaign allowed to send after the sequence has closed, because
       it is what closes it. See templateEligible. */
    finalFreeVisitReminder: true,
    subject: "Last reminder about your free visit",
    altSubject: "The last free-visit reminder",
    preheader: "Available now. The last reminder we will send about it.",
    headline: "Last reminder about the free visit",
    paragraphs: [
      /*
       * The promise is narrow and has to stay narrow: this is the last
       * REMINDER ABOUT THE FREE VISIT, not the last email we ever send. The
       * eligibility rules enforce exactly that and no more, and the copy must
       * not claim a silence the system is not going to keep.
       */
      "This is the last reminder we will send about your free first visit.",
      "It is available now. One job, labor and the trip included, no membership required.",
      "If something around the house has been annoying you for months, that is what it is for. If not, no harm done - we will stop bringing this one up.",
    ],
    ctaLabel: "Book your free visit", ctaRoute: "book",
    closing: "If you would rather have a Fixter coming regularly, membership starts at $149 a month. Otherwise, we will see you whenever something breaks.",
  },
  {
    id: "nonmember_membership_intro_v1",
    audience: "non_member", category: CATEGORY.MEMBERSHIP, topic: "membership",
    /* Day 52, not 15: after the free-visit sequence has closed. */
    kind: KIND.SELL, lifecycleDay: 52, priority: PRIORITY.LIFECYCLE,
    subject: "A Fixter when you need one",
    altSubject: "Stop keeping a list",
    preheader: "Membership means help before the list gets long.",
    headline: "A Fixter when you need one",
    paragraphs: [
      "Most people wait until they have a whole list before calling anyone. Then the list feels like a project, and it gets postponed again.",
      "Membership works the other way around. You have someone booked in regularly, so things get handled while they are still small.",
      "No hunting for someone who answers the phone. No waiting weeks.",
    ],
    ctaLabel: "See how membership works", ctaRoute: "membership",
  },
  {
    id: "nonmember_one_time_v1",
    audience: "non_member", category: CATEGORY.ONE_TIME, topic: "one_time",
    /* Day 66. Never sell a paid visit while a free one is still owed. */
    kind: KIND.SELL, lifecycleDay: 66, priority: PRIORITY.LIFECYCLE,
    subject: "One job, one visit, no membership",
    altSubject: "Just need one thing done",
    preheader: "A single visit, no membership required.",
    headline: "One job, one visit",
    paragraphs: [
      "You do not need a membership to get a Fixter out.",
      "Book a One-Time Visit for a single job. We bring the tools, you get it off your list.",
      "If it turns out you would rather have someone regularly, membership is there when you want it.",
    ],
    ctaLabel: "Book a single visit", ctaRoute: "bookOneTime",
  },
  {
    id: "nonmember_annual_value_v1",
    audience: "non_member", category: CATEGORY.ANNUAL, topic: "annual",
    kind: KIND.SELL, lifecycleDay: 80, priority: PRIORITY.LIFECYCLE,
    requiresAnnualPricingWorking: true,
    subject: "Twelve months for the price of ten",
    altSubject: "The simplest way to save on membership",
    preheader: "Annual membership: pay for 10 months, get 12.",
    headline: "Twelve months for the price of ten",
    paragraphs: [
      "If you are going to have a Fixter for the year anyway, annual billing is the cheaper way to do it.",
      "Pay for ten months. Get twelve.",
      "Same membership, same visits, two months you did not pay for.",
    ],
    ctaLabel: "Compare plans", ctaRoute: "plans",
  },
  {
    id: "nonmember_full_day_v1",
    audience: "non_member", category: CATEGORY.FULL_DAY, topic: "full_day",
    kind: KIND.SELL, lifecycleDay: 95, priority: PRIORITY.LIFECYCLE,
    subject: "Some houses need a day, not a visit",
    altSubject: "One Fixter, one day, your whole list",
    preheader: "A Full Day is one Fixter for about eight hours.",
    headline: "Some houses need a day, not a visit",
    paragraphs: [
      "Some houses do not need one job done. They need a day.",
      "A Full Day Fixter is one person for around eight hours, working down your list in the order you give it.",
      "Best for the list that has been building for a while.",
    ],
    ctaLabel: "See how a Full Day works", ctaRoute: "bookFullDay",
  },
  {
    id: "nonmember_projects_v1",
    audience: "non_member", category: CATEGORY.PROJECT, topic: "project",
    kind: KIND.SELL, lifecycleDay: 110, priority: PRIORITY.LIFECYCLE,
    subject: "Kitchens, bathrooms, roofs and the rest",
    altSubject: "We do more than the small stuff",
    preheader: "Kitchens, bathrooms, roofing, siding and full renovations.",
    headline: "We do more than the small stuff",
    paragraphs: [
      "ProFixter is not only for small jobs.",
      "If you have been putting off something larger, we can look at it and give you an estimate.",
    ],
    bullets: ["Kitchen remodeling", "Bathroom remodeling", "Roofing", "Siding", "Full home renovations"],
    ctaLabel: "Ask for an estimate", ctaRoute: "projectEstimate",
  },
];

/* ------------------------------------------------------------------ */
/* Non member long term rotation                                       */
/* ------------------------------------------------------------------ */

const NON_MEMBER_ROTATION = [
  {
    id: "nonmember_membership_time_v1",
    audience: "non_member", category: CATEGORY.MEMBERSHIP, topic: "membership",
    kind: KIND.SELL, priority: PRIORITY.ROTATION,
    subject: "It is not really about the fixing",
    altSubject: "The part that actually takes the time",
    preheader: "Finding someone reliable is the hard part.",
    headline: "It is not really about the fixing",
    paragraphs: [
      "The hard part of home maintenance is rarely the work itself. It is finding somebody who answers, shows up, and does a decent job.",
      "That is most of what a membership is: knowing who is coming.",
    ],
    ctaLabel: "Compare plans", ctaRoute: "plans",
  },
  {
    id: "nonmember_trust_local_v1",
    audience: "non_member", category: CATEGORY.TRUST, topic: "trust",
    kind: KIND.HELP, priority: PRIORITY.ROTATION,
    subject: "Licensed, insured and local",
    altSubject: "Who is actually coming to your house",
    preheader: "Serving Nassau and Suffolk.",
    headline: "Who is actually coming to your house",
    paragraphs: [
      "ProFixter is a Long Island company. Licensed, insured, and working across Nassau and Suffolk.",
      "You get the same Fixters each time, so whoever comes already knows your house.",
    ],
    ctaLabel: "See what we handle", ctaRoute: "services",
  },
  {
    id: "nonmember_trust_pricing_v1",
    audience: "non_member", category: CATEGORY.TRUST, topic: "pricing",
    kind: KIND.HELP, priority: PRIORITY.ROTATION,
    subject: "You know the price before we start",
    altSubject: "No surprise invoices",
    preheader: "Predictable pricing, agreed up front.",
    headline: "You know the price before we start",
    paragraphs: [
      "You know what a visit costs before anybody shows up.",
      "No guessing, and no invoice at the end that does not match the conversation at the beginning.",
    ],
    ctaLabel: "See pricing", ctaRoute: "plans",
  },
  {
    id: "nonmember_one_time_second_v1",
    audience: "non_member", category: CATEGORY.ONE_TIME, topic: "one_time",
    kind: KIND.SELL, priority: PRIORITY.ROTATION,
    subject: "Try us on something small",
    altSubject: "One job, no commitment",
    preheader: "A single visit with no commitment.",
    headline: "Try us on something small",
    paragraphs: [
      "If you are not ready for a membership, that is fine. Book a single visit and see how it goes.",
      "Pick the job that has been bothering you longest.",
    ],
    ctaLabel: "Book a single visit", ctaRoute: "bookOneTime",
  },
  {
    id: "nonmember_full_day_second_v1",
    audience: "non_member", category: CATEGORY.FULL_DAY, topic: "full_day",
    kind: KIND.SELL, priority: PRIORITY.ROTATION,
    subject: "A whole day, a whole list",
    altSubject: "When one visit will not clear it",
    preheader: "One Fixter for around eight hours.",
    headline: "A whole day, a whole list",
    paragraphs: [
      "If the list has gotten past the point where one visit will do it, book a Full Day.",
      "One Fixter, around eight hours, working through everything in the order you want.",
    ],
    ctaLabel: "See how a Full Day works", ctaRoute: "bookFullDay",
  },
  {
    id: "nonmember_project_kitchen_bath_v1",
    audience: "non_member", category: CATEGORY.PROJECT, topic: "project",
    kind: KIND.SELL, priority: PRIORITY.ROTATION,
    subject: "Kitchen or bathroom on your mind?",
    altSubject: "The project you keep researching",
    preheader: "We handle full kitchen and bathroom remodels.",
    headline: "Kitchen or bathroom on your mind?",
    paragraphs: [
      "Most people think about it for a year or two before they ask anybody.",
      "An estimate costs nothing and makes the decision a lot easier.",
    ],
    ctaLabel: "Ask for an estimate", ctaRoute: "projectEstimate",
  },
  {
    id: "nonmember_project_exterior_v1",
    audience: "non_member", category: CATEGORY.PROJECT, topic: "project_exterior",
    kind: KIND.SELL, priority: PRIORITY.ROTATION,
    subject: "Roofing and siding do not announce themselves",
    altSubject: "How the outside is holding up",
    preheader: "Roofing, siding and exterior work.",
    headline: "Roofing and siding do not announce themselves",
    paragraphs: [
      "Roofing and siding are easy to ignore right up until they are not.",
      "If you have been wondering how much longer yours has, it is worth having someone look.",
    ],
    ctaLabel: "Ask for an estimate", ctaRoute: "projectEstimate",
  },
];

/* ------------------------------------------------------------------ */
/* Track B: the free visit happened and they did not join              */
/* ------------------------------------------------------------------ */

/*
 * The warmest audience we have, and until now the one with no sequence.
 *
 * These people let a stranger into their house on the strength of a website.
 * They have met a Fixter, watched the work, and decided nothing yet. At the
 * time this was written eight customers were in that state and two of the ten
 * who had completed a free visit had gone on to join, which is a twenty per
 * cent conversion with no follow-up at all.
 *
 * Every day here counts from the visit, never from the account. Somebody who
 * registered in March and had their visit yesterday is on day one.
 *
 * What these four deliberately do NOT do is repeat the completion email, the
 * tip link or the review request. Those already go out within an hour of the
 * Fixter leaving. The first of these is two days later for that reason.
 */
const POST_FREE_VISIT = [
  {
    id: "postfree_thanks_v1",
    audience: "non_member", category: CATEGORY.POST_FREE_VISIT, topic: "post_free_thanks",
    kind: KIND.SELL, trackBDay: 2, priority: PRIORITY.POST_FREE_VISIT,
    subject: "How did the visit go?",
    altSubject: "Thanks for trying ProFixter",
    preheader: "Thanks for trying us. Here is what membership does next.",
    headline: "How did it go?",
    paragraphs: [
      ({ name }) => `Hi ${name}, thanks for having a Fixter out. We hope the job got done properly and the house is one item shorter.`,
      "You have tried ProFixter now. If having a Fixter handle that job made life easier, membership is how you keep that help available for the things that come up around the house.",
      "No rush. Have a look and decide whenever it suits you.",
    ],
    ctaLabel: "See membership", ctaRoute: "membership",
    closing: "Not ready for that? You can always book another single visit.",
    closingLinkLabel: "Book another visit", closingLinkRoute: "book",
  },
  {
    id: "postfree_whats_next_v1",
    audience: "non_member", category: CATEGORY.POST_FREE_VISIT, topic: "post_free_next",
    kind: KIND.SELL, trackBDay: 6, priority: PRIORITY.POST_FREE_VISIT,
    subject: "What's next on your list?",
    altSubject: "The rest of the list",
    preheader: "One job got done. Most houses have a few more.",
    headline: "What's next on your list?",
    paragraphs: [
      "Most houses have more than one thing waiting. The faucet gets fixed and the door still sticks.",
      /*
       * The value is the ongoing help, not the saved booking form. An earlier
       * draft closed on "membership just means not booking each one from
       * scratch", which sells a convenience nobody would pay $149 a month for.
       *
       * And the comparison is between two things we sell, so it is written as
       * a question of which fits rather than as a complaint about one of them.
       * A draft that called booking single visits "the tiring way to do it"
       * was running down the One-Time Visit to sell the membership, which is
       * an odd thing to do to a product of our own - and to the customer who
       * just used one.
       */
      "When little jobs keep coming up, membership can make more sense than arranging help separately each time. Scheduled handyman visits through the year, with labor and the trip included on them, and our own in-house Fixters doing the work.",
      "The list most people recognise:",
    ],
    bullets: [
      "The door that has never closed quite right",
      "Shelves and mirrors still in their boxes",
      "A faucet that drips at night",
      "Hardware that has worked loose",
      "The light nobody has been tall enough to change",
    ],
    ctaLabel: "See how membership works", ctaRoute: "membership",
    closing: "Booking a membership visit takes about a minute, and the list stops growing.",
  },
  {
    id: "postfree_membership_v1",
    audience: "non_member", category: CATEGORY.POST_FREE_VISIT, topic: "post_free_membership",
    kind: KIND.SELL, trackBDay: 14, priority: PRIORITY.POST_FREE_VISIT,
    subject: "Keep your Fixter available",
    altSubject: "Instead of searching for someone again",
    preheader: "Membership from $149 a month. Labor and trip included on visits.",
    headline: "Keep your Fixter available",
    paragraphs: [
      "The useful part of ProFixter is not the first visit. It is not having to find somebody the next time.",
      /*
       * Deliberately not "the same team" or "your Fixter". We do not guarantee
       * a named person on every visit, and copy that quietly promises one is a
       * disappointment scheduled for whenever somebody is on holiday.
       */
      "That is what membership is - the work scheduled through the year instead of found each time it is needed:",
    ],
    bullets: [
      "Scheduled handyman visits through the year",
      "Labor and the trip included on membership visits",
      "Easy booking - about a minute",
      "In-house trained Fixters, licensed and insured",
      "Plans start at $149 a month",
    ],
    ctaLabel: "Compare plans", ctaRoute: "plans",
    closing: "Still only one job a year? A single visit is always there instead.",
  },
  {
    id: "postfree_honest_v1",
    audience: "non_member", category: CATEGORY.POST_FREE_VISIT, topic: "post_free_honest",
    kind: KIND.SELL, trackBDay: 30, priority: PRIORITY.POST_FREE_VISIT,
    subject: "When membership is worth it, and when it isn't",
    altSubject: "The honest version",
    preheader: "The last note about membership for a while.",
    headline: "When it is worth it, and when it isn't",
    paragraphs: [
      /*
       * "The last of these" - this sequence - not "the last time we contact
       * you". They rejoin ordinary light marketing afterwards and the copy
       * must not promise a silence that is not coming.
       */
      "This is the last of these membership notes, so here is the honest version.",
      "If you have one job a year, book single visits. That is cheaper and we would rather you did it that way.",
      "Membership is worth it when things keep coming up and you are tired of finding someone every time. That is the whole argument.",
      "Either way you have used us once and you know how we work, which is the part that usually takes longest.",
    ],
    ctaLabel: "See membership", ctaRoute: "membership",
    closing: "And if you just need one thing done, book a visit whenever you like.",
    closingLinkLabel: "Book a visit", closingLinkRoute: "book",
  },
];

/** The campaign whose copy promises the free-visit reminders will stop. */
const FINAL_FREE_VISIT_CAMPAIGN_ID = "nonmember_free_visit_final_v1";

/* ------------------------------------------------------------------ */
/* Members                                                             */
/* ------------------------------------------------------------------ */

const MEMBER_ACTIVATION = [
  {
    id: "member_activation_day3_v1",
    audience: "member", category: CATEGORY.ACTIVATION, topic: "activation_first",
    kind: KIND.HELP, activationDay: 3, priority: PRIORITY.ACTIVATION,
    subject: "Your Fixter is ready",
    altSubject: "Ready when you are",
    preheader: "Your membership is active. Book your first visit.",
    headline: "Your Fixter is ready when you are",
    paragraphs: [
      ({ name }) => `Hi ${name}, your ProFixter membership is active.`,
      "You have not booked your first visit yet. Whenever you are ready, it takes about a minute.",
      "Most people start with whatever has been bothering them longest.",
    ],
    ctaLabel: "Book your first visit", ctaRoute: "bookMembership",
  },
  {
    id: "member_activation_day7_v1",
    audience: "member", category: CATEGORY.ACTIVATION, topic: "activation_second",
    kind: KIND.HELP, activationDay: 7, priority: PRIORITY.ACTIVATION,
    subject: "Anything you've been putting off?",
    altSubject: "What can we take off your list?",
    preheader: "Your membership visit is waiting to be booked.",
    headline: "Anything you've been putting off?",
    paragraphs: [
      "Your membership is active and your visit is still there whenever you want it.",
      "If you are not sure what to use it on, this is what people usually start with:",
    ],
    bullets: [
      "Mounting a TV, mirror or shelves",
      "A door that sticks or will not latch",
      "Replacing a light fixture",
      "A dripping faucet",
      "Tightening everything that has worked loose",
    ],
    ctaLabel: "Book your visit", ctaRoute: "bookMembership",
  },
];

const MEMBER_USAGE = [
  {
    id: "member_usage_five_things_v1", topic: "usage_examples",
    subject: "Five things your Fixter can handle", altSubject: "What can we take off your list?",
    preheader: "If you are not sure what to book, start here.",
    headline: "Five things your Fixter can handle",
    paragraphs: ["If you are not sure what to use your next visit on:"],
    bullets: [
      "Mount the thing still leaning against the wall",
      "Fix the door that sticks",
      "Replace a tired light fixture",
      "Take care of the dripping faucet",
      "Go around tightening everything loose",
    ],
    ctaLabel: "Book your next visit",
  },
  {
    id: "member_usage_walk_past_v1", topic: "usage_notice",
    subject: "The thing you have stopped seeing", altSubject: "What you walk past every day",
    preheader: "The jobs you have stopped noticing.",
    headline: "The thing you have stopped seeing",
    paragraphs: [
      "There is usually something you have stopped noticing because it has been that way so long.",
      "Your next visit is a good use for it.",
    ],
    ctaLabel: "Book it in",
  },
  {
    id: "member_usage_not_broken_v1", topic: "usage_improve",
    subject: "Your Fixter is not only for broken things", altSubject: "Improvements, not just repairs",
    preheader: "Shelves, mounting, hardware and small upgrades.",
    headline: "Your Fixter is not only for broken things",
    paragraphs: [
      "Plenty of visits are not repairs at all.",
      "Shelves that would make a closet work properly, hardware that would make a kitchen feel newer, something mounted where you actually want it.",
    ],
    ctaLabel: "Book an improvement",
  },
  {
    id: "member_usage_small_batch_v1", topic: "usage_batch",
    subject: "Use your next visit on the little things", altSubject: "Save them up, do them together",
    preheader: "Several small jobs in one visit.",
    headline: "Use your next visit on the little things",
    paragraphs: [
      "You do not have to save your visit for something big.",
      "A handful of five-minute jobs in one go is often the most satisfying visit people book.",
    ],
    ctaLabel: "Book the small stuff",
  },
  {
    id: "member_usage_season_spring_v1", topic: "usage_spring", season: "spring",
    subject: "The spring once-over", altSubject: "What the winter loosened",
    preheader: "A seasonal pass around the house.",
    headline: "The spring once-over",
    paragraphs: [
      "Good time to go around the house and deal with whatever the winter loosened, cracked or wore out.",
    ],
    ctaLabel: "Book the spring visit",
  },
  {
    id: "member_usage_season_fall_v1", topic: "usage_fall", season: "fall",
    subject: "Before the weather turns", altSubject: "The fall once-over",
    preheader: "Small jobs worth doing before winter.",
    headline: "Before the weather turns",
    paragraphs: [
      "Doors that stick when it gets damp, hardware that has worked loose over the summer, lights you will actually notice once it is dark at five.",
    ],
    ctaLabel: "Book before winter",
  },
  {
    id: "member_usage_guests_v1", topic: "usage_guests",
    subject: "Hosting soon?", altSubject: "Before everyone arrives",
    preheader: "The jobs you notice when guests are coming.",
    headline: "Hosting soon?",
    paragraphs: [
      "If people are coming over, this is when you start noticing the patch on the wall and the door that sticks.",
      "Worth booking a visit before rather than after.",
    ],
    ctaLabel: "Book before they arrive",
  },
  {
    id: "member_usage_one_room_v1", topic: "usage_room",
    subject: "Finish one room properly", altSubject: "Start with the room that annoys you",
    preheader: "Finish one room instead of half of several.",
    headline: "Finish one room properly",
    paragraphs: [
      "Rather than doing a bit everywhere, pick the one room that bothers you and have it finished properly.",
    ],
    ctaLabel: "Pick a room and book",
  },
].map((usage) => ({
  ...usage,
  audience: "member",
  category: CATEGORY.USAGE,
  kind: KIND.HELP,
  priority: PRIORITY.ROTATION,
  ctaRoute: "bookMembership",
}));

const MEMBER_OTHER = [
  {
    id: "member_upgrade_next_plan_v1",
    audience: "member", category: CATEGORY.UPGRADE, topic: "upgrade",
    kind: KIND.SELL, priority: PRIORITY.ROTATION, requiresUpgradeAvailable: true,
    subject: "There is a plan that fits how you are using it",
    altSubject: "Using your membership more than you expected",
    preheader: "If you are booking often, the next plan up may suit you better.",
    headline: "There is a plan that fits how you are using it",
    paragraphs: [
      "If you find yourself wanting more visits than your plan includes, there is a plan above yours that probably fits better.",
      "Same Fixters, more included, and priority scheduling on the days when something cannot wait.",
    ],
    ctaLabel: "Compare plans", ctaRoute: "plans",
  },
  {
    id: "member_upgrade_full_day_included_v1",
    audience: "member", category: CATEGORY.UPGRADE, topic: "upgrade_elite",
    kind: KIND.SELL, priority: PRIORITY.ROTATION, requiresUpgradeAvailable: true,
    subject: "A full day, included", altSubject: "What Elite includes",
    preheader: "Elite includes a Full Day each billing period.",
    headline: "A full day, included",
    paragraphs: [
      "Elite includes one Full Day Fixter every billing period: one person for around eight hours, working through your list.",
      "It suits houses that generate work faster than a single visit can clear.",
    ],
    ctaLabel: "Compare plans", ctaRoute: "plans",
  },
  {
    id: "member_annual_switch_v1",
    audience: "member", category: CATEGORY.ANNUAL, topic: "annual",
    kind: KIND.SELL, priority: PRIORITY.ROTATION,
    requiresMonthlyBilling: true, requiresAnnualPricingWorking: true,
    subject: "Twelve months for the price of ten", altSubject: "Planning to keep your membership?",
    preheader: "Switch to annual billing and get two months free.",
    headline: "Planning to keep your membership?",
    paragraphs: [
      "If you are staying with us for the year anyway, annual billing is simply cheaper.",
      "Pay for ten months. Get twelve.",
    ],
    ctaLabel: "See annual pricing", ctaRoute: "plans",
  },
  {
    id: "member_project_bigger_v1",
    audience: "member", category: CATEGORY.PROJECT, topic: "project",
    kind: KIND.SELL, priority: PRIORITY.ROTATION,
    subject: "Your Fixter handles the small stuff. We handle the big stuff too.",
    altSubject: "Thinking about a bigger project?",
    preheader: "Kitchens, bathrooms, roofing, siding, renovations.",
    headline: "Your Fixter handles the small stuff. We handle the big stuff too.",
    paragraphs: [
      "You already know how we work. If there is something larger you have been thinking about, we can look at it.",
    ],
    bullets: ["Kitchen remodeling", "Bathroom remodeling", "Roofing", "Siding", "Full home renovations"],
    ctaLabel: "Ask for an estimate", ctaRoute: "projectEstimate",
  },
  {
    id: "member_project_kitchen_v1",
    audience: "member", category: CATEGORY.PROJECT, topic: "project_kitchen",
    kind: KIND.SELL, priority: PRIORITY.ROTATION,
    subject: "The kitchen you keep thinking about", altSubject: "Kitchen and bathroom remodels",
    preheader: "An estimate makes the decision easier.",
    headline: "The kitchen you keep thinking about",
    paragraphs: [
      "Most people think about it for a couple of years before asking anyone what it would cost.",
      "You already know the people who would be doing it.",
    ],
    ctaLabel: "Ask for an estimate", ctaRoute: "projectEstimate",
  },
  {
    id: "member_project_exterior_v1",
    audience: "member", category: CATEGORY.PROJECT, topic: "project_exterior",
    kind: KIND.SELL, priority: PRIORITY.ROTATION,
    subject: "Roofing and siding, before they force the issue",
    altSubject: "How the outside is holding up",
    preheader: "Roofing, siding and exterior projects.",
    headline: "Roofing and siding, before they force the issue",
    paragraphs: [
      "Roofing and siding tend to get ignored until they cannot be.",
      "If you have been wondering, it is worth having someone look.",
    ],
    ctaLabel: "Ask for an estimate", ctaRoute: "projectEstimate",
  },
  {
    id: "member_full_day_list_v1",
    audience: "member", category: CATEGORY.FULL_DAY, topic: "full_day",
    kind: KIND.SELL, priority: PRIORITY.ROTATION,
    subject: "When one visit will not clear it", altSubject: "A whole day for the whole list",
    preheader: "A Full Day is one Fixter for around eight hours.",
    headline: "When one visit will not clear it",
    paragraphs: [
      "Some weeks the list gets past what a single visit can clear.",
      "A Full Day is one Fixter for around eight hours, working straight down it.",
    ],
    ctaLabel: "See how a Full Day works", ctaRoute: "bookFullDay",
  },
  {
    id: "member_full_day_seasonal_v1",
    audience: "member", category: CATEGORY.FULL_DAY, topic: "full_day_backlog",
    kind: KIND.SELL, priority: PRIORITY.ROTATION,
    subject: "One day, everything on the list", altSubject: "Clear the backlog in a day",
    preheader: "For when the list has built up.",
    headline: "One day, everything on the list",
    paragraphs: [
      "If things have quietly accumulated, a Full Day clears the backlog in one go rather than over months of visits.",
    ],
    ctaLabel: "See how a Full Day works", ctaRoute: "bookFullDay",
  },
  {
    id: "member_referral_v1",
    audience: "member", category: CATEGORY.REFERRAL, topic: "referral",
    kind: KIND.SELL, priority: PRIORITY.ROTATION,
    subject: "Know someone who needs a Fixter?", altSubject: "$50 off for a referral",
    preheader: "Refer someone who joins and get $50 off your next charge.",
    headline: "Know someone who needs a Fixter?",
    paragraphs: [
      "If you know somebody who could use us, send us their name.",
      "If they become a ProFixter member, we will take $50 off your next membership charge.",
      "Reply to this email or call 631-599-1363 with their name so we can connect the referral.",
    ],
    ctaLabel: "See what we handle", ctaRoute: "services",
    closing: "Credit is applied by our team once their membership starts.",
  },
  {
    id: "member_referral_neighbor_v1",
    audience: "member", category: CATEGORY.REFERRAL, topic: "referral_neighbor",
    kind: KIND.SELL, priority: PRIORITY.ROTATION,
    subject: "Your neighbors ask you this", altSubject: "Who do you use?",
    preheader: "Refer someone who joins and get $50 off your next charge.",
    headline: "Who do you use?",
    paragraphs: [
      "It is the question everyone asks when they see a van outside.",
      "If you pass our name on and they become a member, we will put $50 off your next membership charge.",
      "Reply to this email or call 631-599-1363 with their name and we will take it from there.",
    ],
    ctaLabel: "See what we handle", ctaRoute: "services",
    closing: "Credit is applied by our team once their membership starts.",
  },
];

/* ------------------------------------------------------------------ */
/* Former members                                                      */
/* ------------------------------------------------------------------ */

/*
 * Somebody who cancelled is not a lead to be recaptured. They tried it and
 * stopped, and the fastest way to make sure they never come back is to send
 * them "we miss you" mail with a discount attached.
 *
 * So: no win-back offers, no guilt, no urgency. Three messages that say the
 * door is open and the work is still available a la carte, plus the whole home
 * fix rotation, which is useful whether or not they ever buy again.
 */
const FORMER_MEMBER = [
  {
    id: "former_one_time_v1",
    audience: "former_member", category: CATEGORY.ONE_TIME, topic: "one_time",
    kind: KIND.SELL, priority: PRIORITY.ROTATION,
    subject: "You can still book a Fixter", altSubject: "No membership needed",
    preheader: "A single visit, whenever you need one.",
    headline: "You can still book a Fixter",
    paragraphs: [
      "Your account is still here, and you do not need a membership to use it.",
      "Book a One-Time Visit whenever something needs doing. Same Fixters, same work, one job at a time.",
    ],
    ctaLabel: "Book a single visit", ctaRoute: "bookOneTime",
  },
  {
    id: "former_full_day_v1",
    audience: "former_member", category: CATEGORY.FULL_DAY, topic: "full_day",
    kind: KIND.SELL, priority: PRIORITY.ROTATION,
    subject: "One Fixter, one day, your whole list", altSubject: "When the list has built up",
    preheader: "A Full Day is one Fixter for around eight hours.",
    headline: "One Fixter, one day, your whole list",
    paragraphs: [
      "Things accumulate. If yours have gotten past what one visit would clear, a Full Day is one Fixter for around eight hours, working straight down the list.",
      "No membership needed.",
    ],
    ctaLabel: "See how a Full Day works", ctaRoute: "bookFullDay",
  },
  {
    id: "former_membership_open_v1",
    audience: "former_member", category: CATEGORY.MEMBERSHIP, topic: "membership",
    kind: KIND.SELL, priority: PRIORITY.ROTATION,
    subject: "Membership is there if you want it again", altSubject: "The door is open",
    preheader: "Whenever it suits you. Nothing to set up again.",
    headline: "Membership is there if you want it again",
    paragraphs: [
      "If having a Fixter booked in regularly turns out to suit you better than calling when something breaks, membership is there whenever you want it.",
      "Your account is still here, so it would just be picking a plan again.",
    ],
    ctaLabel: "Compare plans", ctaRoute: "plans",
  },
];

const MEMBER_ROTATION = [...MEMBER_USAGE, ...MEMBER_OTHER];

/* ------------------------------------------------------------------ */
/* Gift membership                                                     */
/* ------------------------------------------------------------------ */

/*
 * Three ways of saying the same true thing, and one shared topic.
 *
 * WHY THEY EACH CARRY THEIR OWN TOPIC
 *
 * They shared one, which spaced them ninety days apart but also meant the
 * whole subject competed for a single turn in the rotation. A member saw
 * gifting less than once a year - too rare for the audience most likely to
 * buy one, since they already know what a Fixter is worth.
 *
 * Separate topics let the three angles take turns independently, and the
 * spacing that sharing a topic used to provide is now explicit:
 * CATEGORY_COOLDOWN_DAYS.gift holds a floor between any two gift emails
 * whatever their topic. Same guarantee, stated rather than implied, and it
 * cannot be lost by renaming a topic.
 *
 * They are ROTATION priority, so they take their turn rather than jumping
 * the queue, and each is SELL, so they are withheld from anybody whose
 * payment is failing.
 *
 * WHAT IS TRUE AND MUST STAY TRUE
 * Four plans. One, two, three, six or twelve months. Paid once, nothing
 * renews. The recipient picks their own property when they claim. GIFT takes
 * 10% off and has no end date, which is why none of this copy has any
 * urgency in it - there is no deadline to invent.
 *
 * The word "discount" is deliberately absent: a test forbids it in anything
 * a former member can receive, and it reads as a sales pitch rather than a
 * present in any case.
 */

const GIFT_PROMO = {
  code: "GIFT",
  label: "Use this code at checkout",
  detail: "Takes 10% off any gift membership. No end date.",
};

const GIFT_LIBRARY = [
  /*
   * The emotional one, and the reason the product exists. Goes to everybody,
   * because caring about somebody is not a function of whether you are a
   * member.
   */
  {
    id: "gift_someone_you_care_about_v1",
    audience: EVERYONE, category: CATEGORY.GIFT, topic: "gift_care",
    kind: KIND.SELL, priority: PRIORITY.ROTATION,
    subject: "Take care of someone you care about",
    altSubject: "A gift that shows up when something breaks",
    preheader: "Reliable help around the house, when they need it.",
    headline: "Give them a little help around the house",
    paragraphs: [
      "Parents who should not be on a ladder any more. A friend in their first place. Somebody who has been meaning to get to a list since last year.",
      "Sometimes the best gift is not another thing to find room for. It is knowing that when something around the house needs attention, a person turns up and deals with it.",
      "A ProFixter gift membership is exactly that: real handyman help for their home, paid for by you, used whenever they need it.",
    ],
    bullets: [
      "Choose Basic, Plus, Premium or Elite",
      "Give one, two, three, six or twelve months",
      "They pick their own property when they claim it",
      "Paid once. Nothing renews and nothing to cancel",
    ],
    promo: GIFT_PROMO,
    ctaLabel: "Give a membership", ctaRoute: "gift",
  },

  /*
   * The occasion one. A new house is the moment the need is most obvious and
   * the moment people are most likely to be shopping for a present anyway.
   */
  {
    id: "gift_new_home_v1",
    audience: EVERYONE, category: CATEGORY.GIFT, topic: "gift_new_home",
    kind: KIND.SELL, priority: PRIORITY.ROTATION,
    subject: "Know someone with a new home?",
    altSubject: "A housewarming gift they will actually use",
    preheader: "Every new house arrives with a list.",
    headline: "A housewarming gift that actually helps",
    paragraphs: [
      "Every new house comes with a list. Blinds to hang, a handle that came loose on day one, a shelf that has to go somewhere, something in the bathroom that was fine at the walkthrough and is not fine now.",
      "It is the least fun part of moving in, and it lands in the weeks when nobody has the time.",
      "Instead of another candle, give them a Fixter for a few months.",
    ],
    bullets: [
      "One, two, three, six or twelve months of help",
      "They choose the property when they claim the gift",
      "Any of the four plans",
    ],
    promo: GIFT_PROMO,
    ctaLabel: "Give a membership", ctaRoute: "gift",
  },

  /*
   * The member one. MEMBER ONLY, and the audience list is the reason: the
   * copy leans on knowing what having a Fixter is like, which is only
   * honestly true of somebody who has one right now. A former member would
   * be told they know something in the present tense that they left behind,
   * and a non member would be sold their own experience of nothing. Those
   * two get the first email instead.
   */
  {
    id: "gift_member_knows_v1",
    audience: "member", category: CATEGORY.GIFT, topic: "gift_member",
    kind: KIND.SELL, priority: PRIORITY.ROTATION,
    subject: "Give someone their own Fixter",
    altSubject: "You already know how this feels",
    preheader: "You already know how convenient this is.",
    headline: "Give ProFixter to someone you care about",
    paragraphs: [
      "You already know what it is like to have a Fixter. Something goes wrong, you book it, somebody who knows your house turns up and it is dealt with.",
      "Most people do not have that. They have a list, and a vague plan to find somebody eventually.",
      "You can give that same help to somebody you care about, for as long as you like.",
    ],
    bullets: [
      "Pick the plan and the number of months",
      "One, two, three, six or twelve",
      "They claim it and choose their own property",
      "Paid once, and it does not renew",
    ],
    promo: GIFT_PROMO,
    ctaLabel: "Give a membership", ctaRoute: "gift",
  },
];

const ALL_TEMPLATES = [
  ...FIRST_CONTACT,
  ...NON_MEMBER_LIFECYCLE,
  ...POST_FREE_VISIT,
  ...NON_MEMBER_ROTATION,
  ...FIX_LIBRARY,
  ...MEMBER_ACTIVATION,
  ...MEMBER_ROTATION,
  ...FORMER_MEMBER,
  ...GIFT_LIBRARY,
];

const BY_ID = new Map(ALL_TEMPLATES.map((template) => [template.id, template]));

/** Everything a given audience could ever receive. */
function templatesFor(audience) {
  return ALL_TEMPLATES.filter((t) => audiencesOf(t).includes(audience));
}

module.exports = {
  ALL_TEMPLATES,
  BOOK_ROUTES,
  BY_ID,
  CATEGORY,
  FINAL_FREE_VISIT_CAMPAIGN_ID,
  FIRST_CONTACT,
  FIX_LIBRARY,
  FORMER_MEMBER,
  GIFT_LIBRARY,
  KIND,
  MEMBER_ACTIVATION,
  MEMBER_ROTATION,
  MEMBER_USAGE,
  NON_MEMBER_LIFECYCLE,
  NON_MEMBER_ROTATION,
  POST_FREE_VISIT,
  PRIORITY,
  audiencesOf,
  ctaFor,
  templatesFor,
};
