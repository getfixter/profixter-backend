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

const NON_MEMBER_LIFECYCLE = [
  {
    id: "nonmember_free_visit_v1",
    audience: "non_member", category: CATEGORY.FREE_VISIT, topic: "free_visit",
    kind: KIND.HELP, lifecycleDay: 2, priority: PRIORITY.LIFECYCLE,
    requiresFreeVisitEligible: true,
    subject: "Your first ProFixter visit is free",
    altSubject: "What needs fixing at home?",
    preheader: "One free visit for your first job. No membership needed.",
    headline: "Your first visit is on us",
    paragraphs: [
      ({ name }) => `Hi ${name}, thanks for setting up your ProFixter account.`,
      "Your first visit is free. Pick something small you have been meaning to take care of and let a Fixter handle it.",
      "Most people start with the thing they walk past every day and have stopped noticing.",
    ],
    ctaLabel: "Book your free visit", ctaRoute: "book",
    closing: "It takes about a minute to book.",
  },
  {
    id: "nonmember_around_house_v1",
    audience: "non_member", category: CATEGORY.FIX, topic: "around_house",
    kind: KIND.HELP, lifecycleDay: 7, priority: PRIORITY.LIFECYCLE,
    subject: "What's been waiting around your house?",
    altSubject: "The small stuff adds up",
    preheader: "The jobs that never quite make it to the top of the list.",
    headline: "What's been waiting around your house?",
    paragraphs: [
      "Most homes have a short list of small things nobody gets around to.",
      "A Fixter can work through several of them in one visit.",
    ],
    bullets: [
      "A TV or mirror still waiting to go up",
      "A door that sticks or will not latch",
      "A dripping faucet",
      "A light fixture that needs replacing",
      "Shelves that never got hung",
      "Loose handles and hardware",
    ],
    ctaLabel: "Book a visit", ctaRoute: "book",
  },
  {
    id: "nonmember_membership_intro_v1",
    audience: "non_member", category: CATEGORY.MEMBERSHIP, topic: "membership",
    kind: KIND.SELL, lifecycleDay: 15, priority: PRIORITY.LIFECYCLE,
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
    kind: KIND.SELL, lifecycleDay: 42, priority: PRIORITY.LIFECYCLE,
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
    kind: KIND.SELL, lifecycleDay: 60, priority: PRIORITY.LIFECYCLE,
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
    kind: KIND.SELL, lifecycleDay: 80, priority: PRIORITY.LIFECYCLE,
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
    kind: KIND.SELL, lifecycleDay: 105, priority: PRIORITY.LIFECYCLE,
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

const ALL_TEMPLATES = [
  ...FIRST_CONTACT,
  ...NON_MEMBER_LIFECYCLE,
  ...NON_MEMBER_ROTATION,
  ...FIX_LIBRARY,
  ...MEMBER_ACTIVATION,
  ...MEMBER_ROTATION,
  ...FORMER_MEMBER,
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
  FIRST_CONTACT,
  FIX_LIBRARY,
  FORMER_MEMBER,
  KIND,
  MEMBER_ACTIVATION,
  MEMBER_ROTATION,
  MEMBER_USAGE,
  NON_MEMBER_LIFECYCLE,
  NON_MEMBER_ROTATION,
  PRIORITY,
  audiencesOf,
  ctaFor,
  templatesFor,
};
