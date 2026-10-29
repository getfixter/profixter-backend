/**
 * Admin: correct a customer's details without MongoDB Compass.
 *
 *   GET   /api/admin/users/:id/profile           the editable snapshot
 *   PATCH /api/admin/users/:id/profile           save an edit
 *   GET   /api/admin/users/:id/profile-history   who changed what, and when
 *
 * Mounted from routes/admin.js (which owns /api/admin), built by a factory so
 * it can reuse that file's per-address plan resolver for the row it returns.
 *
 * WHO MAY DO WHAT (enforced here, never by hiding buttons)
 *   - Names and saved addresses: the owner, or an employee holding the "All
 *     Users" section (customers.manage). That permission is defined as
 *     "customer accounts: contact details, addresses, plans, SMS consent,
 *     edits", and the existing PUT /users/:id has always let it edit names.
 *   - Phone and email: the OWNER only. They are ways into the account (see
 *     utils/customerProfileEdit), so whoever can change them can choose who is
 *     able to sign in. No section grants that.
 *   - Customer accounts only. The owner's own account and staff accounts are
 *     refused for everyone; staff are managed in Fixters.
 *
 * The rules themselves live in utils/customerProfileEdit.js.
 */
const express = require("express");
const mongoose = require("mongoose");

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission, requireAnyPermission } = require("../middleware/authorize");
const User = require("../models/User");
const Booking = require("../models/Booking");
const Subscription = require("../models/Subscription");
const GiftMembership = require("../models/GiftMembership");
const LoyaltyGrant = require("../models/LoyaltyGrant");
const LoyaltyCycle = require("../models/LoyaltyCycle");
const EmailSuppression = require("../models/EmailSuppression");
const AdminActivityLog = require("../models/AdminActivityLog");
const { createAdminActivityLog, markAdminActivityLog } = require("../utils/adminActivityLog");
const { buildUserSearchFields } = require("../utils/userSearchFields");
const { normalizeEmail, normalizePhoneE164 } = require("../utils/identity");
const { consentResetForPhoneChange } = require("../utils/sms/consentOnPhoneChange");
const { buildAddressKey } = require("../utils/introVisitEligibility");
const { completedBookingCountForUser } = require("../utils/customerBookingCounts");
const {
  ALLOWED_BODY_KEYS,
  MAX_ADDRESSES,
  buildAddress,
  cleanText,
  formatAddress,
  maskEmail,
  maskPhone,
  readContact,
  signInMethods,
  splitName,
  summarise,
} = require("../utils/customerProfileEdit");

const ADMIN_EMAIL = () => String(process.env.MAIL_ADMIN || "getfixter@gmail.com").toLowerCase();
const isOwnerAccount = (user) => String(user?.email || "").toLowerCase() === ADMIN_EMAIL() || user?.role === "admin";
const isStaffAccount = (user) => isOwnerAccount(user) || user?.role === "employee";

const ACTION_DONE = "Customer Profile Updated";
const ACTION_STARTED = "Customer Profile Update Started";
const ACTION_FAILED = "Customer Profile Update Failed";
/* Subscription states that still mean "this property has a plan". Local only: no Stripe call. */
const LIVE_PLAN_STATUSES = ["active", "trialing", "past_due"];

/** Addresses that carry history: removing one would orphan bookings, plans, gifts or loyalty. */
async function addressesWithHistory(user) {
  const userId = user._id;
  const ids = (user.addresses || []).map((a) => a._id);
  if (!ids.length) return new Set();
  const [bookings, subscriptions, gifts, grants, cycles] = await Promise.all([
    Booking.distinct("addressId", { user: userId, addressId: { $in: ids } }),
    Subscription.distinct("addressId", { user: userId, addressId: { $in: ids } }),
    GiftMembership.distinct("addressId", { addressId: { $in: ids } }),
    LoyaltyGrant.distinct("addressId", { user: userId, addressId: { $in: ids } }),
    LoyaltyCycle.distinct("addressId", { user: userId, addressId: { $in: ids } }),
  ]);
  const out = new Set([...bookings, ...subscriptions, ...gifts, ...grants, ...cycles].filter(Boolean).map(String));
  for (const a of user.addresses || []) {
    // A claimed or used free visit is recorded on the address itself.
    if (["claimed", "consumed"].includes(a.introVisit?.status)) out.add(String(a._id));
  }
  return out;
}

async function addressesWithLivePlan(user) {
  const rows = await Subscription.distinct("addressId", { user: user._id, status: { $in: LIVE_PLAN_STATUSES } });
  return new Set(rows.filter(Boolean).map(String));
}

function profileDTO(user, { locked, livePlans }) {
  const names = splitName(user);
  const defaultId = user.defaultAddressId ? String(user.defaultAddressId) : null;
  return {
    _id: String(user._id),
    userId: user.userId,
    name: user.name || "",
    firstName: names.firstName,
    lastName: names.lastName,
    email: user.email || "",
    phone: user.phone || "",
    emailVerifiedAt: user.emailVerifiedAt || null,
    phoneVerifiedAt: user.phoneVerifiedAt || null,
    emailIsAppleRelay: Boolean(user.emailIsAppleRelay),
    hasGoogle: Boolean(user.googleId),
    hasApple: Boolean(user.appleId),
    hasPassword: Boolean(user.password),
    signInMethods: signInMethods(user),
    stripeCustomer: Boolean(user.stripeCustomerId),
    updatedAt: user.updatedAt || null,
    defaultAddressId: defaultId,
    addresses: (user.addresses || []).map((a) => ({
      _id: String(a._id),
      label: a.label || "",
      line1: a.line1 || "",
      city: a.city || "",
      state: a.state || "",
      zip: a.zip || "",
      county: a.county || "",
      placeId: a.placeId || "",
      isDefault: String(a._id) === defaultId,
      introVisitStatus: a.introVisit?.status || null,
      hasHistory: locked.has(String(a._id)),
      hasActivePlan: livePlans.has(String(a._id)),
    })),
  };
}

/** Change rows with phone/email masked, for anyone who is not the owner. */
function maskedChanges(changes) {
  return changes.map(({ field, label, from, to, sensitive }) => ({
    field,
    label,
    from: sensitive ? (field === "phone" ? maskPhone(from) : maskEmail(from)) : from,
    to: sensitive ? (field === "phone" ? maskPhone(to) : maskEmail(to)) : to,
    ...(sensitive ? { sensitive: true } : {}),
  }));
}

module.exports = function createAdminCustomerProfileRouter({ getAddressPlansForUser } = {}) {
  const router = express.Router();
  const customersManage = requirePermission(PERMISSIONS.CUSTOMERS_MANAGE);
  const customersOrMembers = requireAnyPermission(PERMISSIONS.CUSTOMERS_MANAGE, PERMISSIONS.MEMBERS_READ);

  /* The target must exist and be a customer: not the owner, not staff. */
  async function loadCustomer(req, res) {
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(400).json({ message: "Invalid user id" });
      return null;
    }
    const user = await User.findById(req.params.id).lean();
    if (!user) {
      res.status(404).json({ message: "User not found" });
      return null;
    }
    if (isStaffAccount(user)) {
      res.status(403).json({ code: "NOT_A_CUSTOMER", message: "Only customer accounts can be edited here." });
      return null;
    }
    return user;
  }

  /* The same row GET /api/admin/users returns, so the list can swap it in place. */
  async function adminRow(userId) {
    const user = await User.findById(userId).select("-password").lean();
    const [addressesDetailed, completedBookings] = await Promise.all([
      getAddressPlansForUser ? getAddressPlansForUser(user) : [],
      completedBookingCountForUser(user),
    ]);
    return { ...user, addressesDetailed, completedBookings };
  }

  router.get("/users/:id/profile", auth, ...customersManage, async (req, res) => {
    try {
      const user = await loadCustomer(req, res);
      if (!user) return undefined;
      const [locked, livePlans] = await Promise.all([addressesWithHistory(user), addressesWithLivePlan(user)]);
      const isOwner = req.accessRole === "admin";
      return res.json({
        profile: profileDTO(user, { locked, livePlans }),
        access: { canEditContact: isOwner, canEditDetails: true },
      });
    } catch (error) {
      console.error("GET /admin/users/:id/profile error:", error);
      return res.status(500).json({ message: "Failed to load the customer profile" });
    }
  });

  router.patch("/users/:id/profile", auth, ...customersManage, async (req, res) => {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};

    /* No mass assignment: role, password, tokenVersion, subscription... are refused by name. */
    const notEditable = Object.keys(body).filter((key) => !ALLOWED_BODY_KEYS.has(key));
    if (notEditable.length) {
      return res.status(400).json({
        code: "FIELDS_NOT_EDITABLE",
        message: `These fields cannot be edited here: ${notEditable.join(", ")}.`,
        fields: notEditable,
      });
    }

    let audit = null;
    try {
      const existing = await loadCustomer(req, res);
      if (!existing) return undefined;
      const isOwner = req.accessRole === "admin";

      if (body.expectedUpdatedAt && existing.updatedAt) {
        if (new Date(body.expectedUpdatedAt).getTime() !== new Date(existing.updatedAt).getTime()) {
          return res.status(409).json({
            code: "STALE",
            message: "This customer was changed by someone else a moment ago. Close and reopen the editor to see the latest details.",
          });
        }
      }

      const errors = {};
      const changes = [];
      const warnings = [];
      const set = {};
      const unset = {};

      /* ---------------------------------------------------------- contact */
      const contact = readContact(body);
      Object.assign(errors, contact.errors);

      const previousPhone = normalizePhoneE164(existing.phone) || String(existing.phone || "").trim();
      const previousEmail = normalizeEmail(existing.email) || "";
      const phoneTouched = body.phone !== undefined;
      const emailTouched = body.email !== undefined;
      const nextPhone = contact.values.phone;
      const nextEmail = contact.values.email;
      const phoneChanged = phoneTouched && (contact.errors.phone ? true : nextPhone !== previousPhone);
      const emailChanged = emailTouched && (contact.errors.email ? true : nextEmail !== previousEmail);

      if (!isOwner && (phoneChanged || emailChanged)) {
        return res.status(403).json({
          code: "OWNER_ONLY_FIELDS",
          message: "Only the owner can change a customer's phone or email.",
          fields: [phoneChanged && "phone", emailChanged && "email"].filter(Boolean),
        });
      }

      if (emailChanged && nextEmail && nextEmail === ADMIN_EMAIL()) {
        errors.email = "This email address is reserved.";
      }

      /* ------------------------------------------------------------ names */
      if (body.firstName !== undefined || body.lastName !== undefined) {
        const current = splitName(existing);
        const firstName = body.firstName !== undefined ? cleanText(body.firstName, 60) : current.firstName;
        const lastName = body.lastName !== undefined ? cleanText(body.lastName, 60) : current.lastName;
        const name = `${firstName} ${lastName}`.trim();
        if (firstName !== current.firstName) changes.push({ field: "firstName", label: "First name", from: current.firstName, to: firstName });
        if (lastName !== current.lastName) changes.push({ field: "lastName", label: "Last name", from: current.lastName, to: lastName });
        if (firstName !== current.firstName || lastName !== current.lastName) {
          Object.assign(set, { firstName, lastName, name });
        }
      }

      /* -------------------------------------------------------- addresses */
      let nextAddresses = null;
      let nextDefaultId = existing.defaultAddressId ? String(existing.defaultAddressId) : null;
      let removedAddresses = [];
      if (body.addresses !== undefined) {
        if (!Array.isArray(body.addresses)) {
          errors.addresses = "Addresses must be a list.";
        } else if (body.addresses.length > MAX_ADDRESSES) {
          errors.addresses = `An account can hold at most ${MAX_ADDRESSES} addresses.`;
        } else {
          const priorById = new Map((existing.addresses || []).map((a) => [String(a._id), a]));
          const seenIds = new Set();
          const entries = [];
          body.addresses.forEach((input, index) => {
            const id = input && input._id ? String(input._id) : "";
            if (id && !priorById.has(id)) {
              errors[`addresses.${index}`] = "This address is no longer on the account. Reopen the editor and try again.";
              return;
            }
            if (id && seenIds.has(id)) {
              errors[`addresses.${index}`] = "The same address was sent twice.";
              return;
            }
            if (id) seenIds.add(id);
            const prior = id ? priorById.get(id) : null;
            const built = buildAddress(input, prior, index);
            if (built.errors) {
              Object.assign(errors, built.errors);
              return;
            }
            entries.push({ index, prior, address: built.address, inServiceArea: built.inServiceArea, isDefault: input?.isDefault === true });
          });

          /* One property, one record: the free-visit and plan state live on it. */
          const byKey = new Map();
          for (const entry of entries) {
            const key = buildAddressKey(entry.address);
            if (byKey.has(key)) {
              errors[`addresses.${entry.index}.line1`] = `This is the same property as address ${byKey.get(key) + 1}.`;
            } else byKey.set(key, entry.index);
          }
          if (entries.filter((entry) => entry.isDefault).length > 1) errors.addresses = "Only one address can be the default.";

          removedAddresses = (existing.addresses || []).filter((a) => !seenIds.has(String(a._id)));

          if (!Object.keys(errors).length) {
            const livePlans = await addressesWithLivePlan(existing);
            nextAddresses = entries.map((entry) => {
              if (!entry.prior) {
                changes.push({ field: "addresses", label: "Address added", from: "", to: formatAddress(entry.address) });
                if (!entry.inServiceArea) {
                  warnings.push({ code: "ADDRESS_OUTSIDE_SERVICE_AREA", message: `${formatAddress(entry.address)} is outside the service area.` });
                }
                return { ...entry.address, _id: new mongoose.Types.ObjectId() };
              }
              const before = formatAddress(entry.prior);
              const after = formatAddress(entry.address);
              const moved = buildAddressKey(entry.prior) !== buildAddressKey(entry.address);
              if (before !== after) changes.push({ field: "addresses", label: "Address", from: before, to: after });
              if ((entry.prior.label || "") !== entry.address.label) {
                changes.push({ field: "addresses", label: "Address label", from: entry.prior.label || "", to: entry.address.label });
              }
              if (moved && !entry.inServiceArea) {
                warnings.push({ code: "ADDRESS_OUTSIDE_SERVICE_AREA", message: `${after} is outside the service area.` });
              }
              if (moved && livePlans.has(String(entry.prior._id))) {
                warnings.push({
                  code: "ADDRESS_HAS_ACTIVE_PLAN",
                  message: `${before} has an active membership. The membership stays with this address and will show the corrected property.`,
                });
              }
              // introVisit, _id and anything else on the record ride along untouched.
              return { ...entry.prior, ...entry.address, _id: entry.prior._id };
            });
            for (const removed of removedAddresses) {
              changes.push({ field: "addresses", label: "Address removed", from: formatAddress(removed), to: "" });
            }

            const chosen = entries.findIndex((entry) => entry.isDefault);
            if (chosen >= 0) nextDefaultId = String(nextAddresses[chosen]._id);
            else if (!nextAddresses.some((a) => String(a._id) === nextDefaultId)) {
              nextDefaultId = nextAddresses[0] ? String(nextAddresses[0]._id) : null;
            }
            const previousDefaultId = existing.defaultAddressId ? String(existing.defaultAddressId) : null;
            if (nextDefaultId !== previousDefaultId) {
              const fromAddress = (existing.addresses || []).find((a) => String(a._id) === previousDefaultId);
              const toAddress = nextAddresses.find((a) => String(a._id) === nextDefaultId);
              changes.push({ field: "defaultAddressId", label: "Default address", from: formatAddress(fromAddress), to: formatAddress(toAddress) });
            }
          }
        }
      }

      if (Object.keys(errors).length) {
        return res.status(400).json({ code: "VALIDATION", message: "Please fix the highlighted fields.", errors });
      }

      /* -------------------------------------------- conflicts and guards */
      if (emailChanged && nextEmail) {
        const holder = await User.findOne({ _id: { $ne: existing._id }, email: nextEmail, role: { $ne: "employee" } }).select("_id").lean();
        if (holder) {
          return res.status(409).json({
            code: "EMAIL_IN_USE",
            message: "Another customer account already uses this email. Accounts are never merged here.",
            errors: { email: "Another customer account already uses this email." },
          });
        }
        if (await User.exists({ email: nextEmail, role: "employee" })) {
          warnings.push({
            code: "EMAIL_ON_STAFF_ACCOUNT",
            message: "A staff account also uses this email. The two accounts stay separate and are not merged.",
          });
        }
      }
      if (phoneChanged && nextPhone) {
        const sharing = await User.countDocuments({
          _id: { $ne: existing._id },
          role: { $ne: "employee" },
          phone: nextPhone,
          phoneVerifiedAt: { $type: "date" },
        });
        if (sharing) {
          warnings.push({
            code: "PHONE_SHARED_VERIFIED",
            message: `${sharing === 1 ? "Another account has" : `${sharing} other accounts have`} verified this phone (a shared household phone is allowed). The accounts stay separate.`,
          });
        }
      }

      if (removedAddresses.length) {
        const locked = await addressesWithHistory(existing);
        const blocked = removedAddresses.filter((a) => locked.has(String(a._id)));
        if (blocked.length) {
          return res.status(409).json({
            code: "ADDRESS_HAS_HISTORY",
            message: `${blocked.map(formatAddress).join("; ")} has bookings, a plan, a gift, loyalty or a free visit on record, so it cannot be removed. Correct it instead.`,
            addressIds: blocked.map((a) => String(a._id)),
          });
        }
      }

      const after = {
        email: emailChanged ? nextEmail : existing.email,
        phone: phoneChanged ? nextPhone : existing.phone,
        phoneVerifiedAt: phoneChanged ? null : existing.phoneVerifiedAt,
        googleId: existing.googleId,
        appleId: existing.appleId,
      };
      if (signInMethods(existing).length && !signInMethods(after).length) {
        return res.status(409).json({
          code: "NO_SIGN_IN_METHOD",
          message: phoneChanged && !after.email
            ? "This customer signs in only with their phone. A new number is not verified, so they would be locked out. Add an email in the same edit, or ask them to change the number from their account."
            : "This would leave the customer with no way to sign in. Keep an email, a verified phone, Google or Apple on the account.",
        });
      }

      /* ------------------------------------------------- contact changes */
      let consentVerdict = null;
      if (phoneChanged) {
        changes.push({ field: "phone", label: "Phone", from: existing.phone || "", to: nextPhone, sensitive: true });
        if (nextPhone) set.phone = nextPhone;
        else unset.phone = "";
        set.phoneVerifiedAt = null;
        consentVerdict = consentResetForPhoneChange({
          previousPhone: existing.phone,
          nextPhone,
          smsPreferences: existing.smsPreferences,
        });
        Object.assign(unset, consentVerdict.unset);
      }
      if (emailChanged) {
        changes.push({ field: "email", label: "Email", from: existing.email || "", to: nextEmail, sensitive: true });
        // Never "" (it would collide in the {email, role} index): absent instead.
        if (nextEmail) set.email = nextEmail;
        else unset.email = "";
        set.emailVerifiedAt = null;
        set.emailIsAppleRelay = false;
      }

      if (nextAddresses) {
        set.addresses = nextAddresses;
        set.defaultAddressId = nextDefaultId ? new mongoose.Types.ObjectId(nextDefaultId) : null;
      }

      if (!changes.length) {
        return res.json({ message: "Nothing to change.", changes: [], notices: [], user: await adminRow(existing._id) });
      }

      if (warnings.length && body.acknowledgeWarnings !== true) {
        return res.status(409).json({
          code: "CONFIRM_WARNINGS",
          message: "Please review before saving.",
          warnings,
        });
      }

      const nextUser = { ...existing, ...set };
      for (const key of Object.keys(unset)) if (!key.includes(".")) delete nextUser[key];
      set.search = buildUserSearchFields(nextUser);

      const phoneVerificationCleared = Boolean(phoneChanged && existing.phoneVerifiedAt);
      const emailVerificationCleared = Boolean(emailChanged && existing.emailVerifiedAt);
      const smsConsentReset = Boolean(consentVerdict?.reset);
      const details = {
        summary: summarise(changes),
        customerName: existing.name || "",
        userId: existing.userId || "",
        changes: maskedChanges(changes),
        ...(changes.some((c) => c.sensitive)
          ? { ownerOnly: { changes: changes.filter((c) => c.sensitive).map(({ field, label, from, to }) => ({ field, label, from, to })) } }
          : {}),
        ...(phoneChanged || emailChanged
          ? {
              adminOverride: {
                phoneVerificationCleared,
                emailVerificationCleared,
                note: "Changed by an admin. The new value is unverified until the customer verifies it themselves.",
              },
            }
          : {}),
        ...(smsConsentReset
          ? { smsConsentReset: { clearedTransactional: consentVerdict.clearedTransactional, clearedMarketing: consentVerdict.clearedMarketing } }
          : {}),
        ...(warnings.length ? { warningsAcknowledged: warnings.map((w) => w.code) } : {}),
        ...(body.reason ? { reason: cleanText(body.reason, 300) } : {}),
      };

      /* Logged before the write, so no edit can ever land unrecorded. */
      audit = await createAdminActivityLog(req, {
        action: ACTION_STARTED,
        entityType: "User",
        entityId: existing._id,
        entityName: existing.name || maskEmail(existing.email) || existing.userId,
        details,
      });

      const write = { $set: set };
      if (Object.keys(unset).length) write.$unset = unset;
      let result;
      try {
        /* Only if nobody changed the record since it was read. */
        result = await User.updateOne({ _id: existing._id, updatedAt: existing.updatedAt ?? null }, write, { runValidators: false });
      } catch (error) {
        if (error?.code === 11000) {
          await markAdminActivityLog(audit, { action: ACTION_FAILED, details: { ...details, failure: "duplicate email" } });
          return res.status(409).json({
            code: "EMAIL_IN_USE",
            message: "Another account already uses this email.",
            errors: { email: "Another account already uses this email." },
          });
        }
        throw error;
      }
      if (!result.matchedCount) {
        await markAdminActivityLog(audit, { action: ACTION_FAILED, details: { ...details, failure: "changed concurrently" } });
        return res.status(409).json({
          code: "STALE",
          message: "This customer was changed by someone else a moment ago. Close and reopen the editor to see the latest details.",
        });
      }
      await markAdminActivityLog(audit, { action: ACTION_DONE, details });

      /* ------------------------------------------------- after the write */
      const notices = [];
      if (phoneChanged) {
        notices.push(
          nextPhone
            ? "The new phone is unverified. The customer can't sign in with it by text code until they verify it themselves."
            : "The phone was removed."
        );
      }
      if (smsConsentReset) {
        notices.push("SMS consent was cleared: it covered the previous number only. The customer can opt in again for the new one.");
        const { recordConsent } = require("../utils/consent/ledger");
        for (const [purpose, cleared] of [["service", consentVerdict.clearedTransactional], ["marketing", consentVerdict.clearedMarketing]]) {
          if (cleared) {
            await recordConsent({
              user: existing._id,
              channel: "sms",
              purpose,
              action: "reset",
              source: "admin_phone_change",
              phone: consentVerdict.previous,
              detail: "consent covered the previous number only",
              req,
            });
          }
        }
      }
      if (emailChanged) {
        notices.push(
          nextEmail
            ? "The new email is unverified until the customer confirms it. Whoever controls that inbox can sign in with an email code."
            : "The email was removed."
        );
        if (existing.stripeCustomerId) {
          // Nothing in the codebase syncs email to Stripe, and this does not start to.
          notices.push("Stripe receipts still go to the email saved on the Stripe customer. Update it in Stripe if needed.");
        }
        /*
         * A marketing unsubscribe (or a manual block) is the PERSON's choice, so
         * it follows them to the new address. Bounces and complaints describe
         * the old mailbox and stay with it.
         */
        if (previousEmail && nextEmail) {
          try {
            const row = await EmailSuppression.findOne({ email: previousEmail }).lean();
            if (row && EmailSuppression.isActive(row) && ["unsubscribe", "manual_blacklist"].includes(row.reason)) {
              await EmailSuppression.updateOne(
                { email: nextEmail },
                {
                  $setOnInsert: {
                    email: nextEmail,
                    reason: row.reason,
                    source: "admin_email_change",
                    detail: "carried over from the customer's previous email",
                    suppressedAt: new Date(),
                  },
                },
                { upsert: true }
              );
              notices.push("Marketing email stays off: the customer had unsubscribed on their previous email.");
            }
          } catch (error) {
            console.error("Suppression carry-over failed:", error.message);
          }
        }
      }

      return res.json({
        message: "Customer updated.",
        changes: isOwner ? changes.map(({ field, label, from, to }) => ({ field, label, from, to })) : maskedChanges(changes),
        notices,
        phoneVerificationCleared,
        emailVerificationCleared,
        smsConsentReset,
        user: await adminRow(existing._id),
      });
    } catch (error) {
      console.error("PATCH /admin/users/:id/profile error:", error);
      if (audit) await markAdminActivityLog(audit, { action: ACTION_FAILED }).catch(() => {});
      return res.status(500).json({ message: "Failed to save the customer" });
    }
  });

  /*
   * The edit history for one customer. Phone and email are masked for everyone
   * but the owner; the full values are stored apart (details.ownerOnly) and the
   * global activity log strips them for staff too.
   */
  router.get("/users/:id/profile-history", auth, ...customersOrMembers, async (req, res) => {
    try {
      const user = await loadCustomer(req, res);
      if (!user) return undefined;
      const isOwner = req.accessRole === "admin";
      const logs = await AdminActivityLog.find({ entityType: "User", entityId: String(user._id), action: ACTION_DONE })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();
      const items = logs.map((log) => {
        const details = log.details || {};
        const full = new Map((details.ownerOnly?.changes || []).map((c) => [c.field, c]));
        const changes = (details.changes || []).map((change) => {
          const shown = isOwner && change.sensitive && full.has(change.field) ? full.get(change.field) : change;
          return { field: change.field, label: change.label, from: shown.from || "", to: shown.to || "", ...(change.sensitive ? { sensitive: true } : {}) };
        });
        return {
          id: String(log._id),
          at: log.createdAt,
          actorName: log.actorName || "",
          actorRole: log.actorRole || "",
          changes,
          verificationCleared: {
            phone: Boolean(details.adminOverride?.phoneVerificationCleared),
            email: Boolean(details.adminOverride?.emailVerificationCleared),
          },
          smsConsentReset: Boolean(details.smsConsentReset),
          reason: details.reason || "",
        };
      });
      return res.json({ items, masked: !isOwner });
    } catch (error) {
      console.error("GET /admin/users/:id/profile-history error:", error);
      return res.status(500).json({ message: "Failed to load the edit history" });
    }
  });

  return router;
};
