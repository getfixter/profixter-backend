const express = require("express");
const bcrypt = require("bcryptjs");
const auth = require("../middleware/auth");
const User = require("../models/User");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");

const router = express.Router();
const POSITIONS = ["Fixter", "General Fixter"];
const adminOnly = requirePermission(PERMISSIONS.ADMIN);

function clean(value) {
  return String(value ?? "").trim();
}

function fixterDTO(user) {
  return {
    id: String(user._id),
    firstName: user.firstName || "",
    lastName: user.lastName || "",
    email: user.email,
    phone: user.phone || "",
    role: user.role,
    employeePosition: user.employeePosition,
    isActive: user.isActive !== false,
    mustChangePassword: !!user.mustChangePassword,
    isDefaultFixter: !!user.isDefaultFixter,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

async function nextUserId() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const userId = Math.floor(10000000 + Math.random() * 90000000).toString();
    if (!(await User.exists({ userId }))) return userId;
  }
  throw new Error("Unable to generate employee ID");
}

function normalizePhone(value) {
  const digits = clean(value).replace(/\D/g, "");
  if (!digits) return "";
  const normalized = digits.length === 10 ? `1${digits}` : digits;
  return normalized.length === 11 && normalized.startsWith("1")
    ? `+${normalized}`
    : null;
}

router.use(auth, ...adminOnly);

router.get("/", async (_req, res) => {
  const rows = await User.find({ role: "employee" }).sort({ createdAt: -1 });
  return res.json({ fixters: rows.map(fixterDTO) });
});

router.post("/", async (req, res) => {
  try {
    const firstName = clean(req.body.firstName);
    const lastName = clean(req.body.lastName);
    const email = clean(req.body.email).toLowerCase();
    const phone = normalizePhone(req.body.phone);
    const employeePosition = clean(req.body.employeePosition);

    if (!firstName || !lastName || !email || !phone) {
      return res.status(400).json({ message: "First name, last name, email, and valid phone are required" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Invalid email" });
    }
    if (!POSITIONS.includes(employeePosition)) {
      return res.status(400).json({ message: "Invalid employee position" });
    }
    if (await User.exists({ email })) {
      return res.status(409).json({ message: "Email already belongs to an account" });
    }

    const user = await User.create({
      userId: await nextUserId(),
      name: `${firstName} ${lastName}`,
      firstName,
      lastName,
      email,
      phone,
      password: await bcrypt.hash("11111111", 10),
      role: "employee",
      employeePosition,
      isActive: true,
      mustChangePassword: true,
      addresses: [],
      defaultAddressId: null,
      subscription: null,
    });
    return res.status(201).json({ fixter: fixterDTO(user) });
  } catch (error) {
    console.error("Create Fixter failed:", error);
    return res.status(500).json({ message: "Failed to create Fixter" });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, role: "employee" });
    if (!user) return res.status(404).json({ message: "Fixter not found" });

    const firstName = clean(req.body.firstName);
    const lastName = clean(req.body.lastName);
    const phone = normalizePhone(req.body.phone);
    const employeePosition = clean(req.body.employeePosition);
    if (!firstName || !lastName || !phone || !POSITIONS.includes(employeePosition)) {
      return res.status(400).json({ message: "Valid name, phone, and position are required" });
    }

    user.firstName = firstName;
    user.lastName = lastName;
    user.name = `${firstName} ${lastName}`;
    user.phone = phone;
    user.employeePosition = employeePosition;
    await user.save();
    return res.json({ fixter: fixterDTO(user) });
  } catch (error) {
    console.error("Update Fixter failed:", error);
    return res.status(500).json({ message: "Failed to update Fixter" });
  }
});

router.patch("/:id/status", async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, role: "employee" });
  if (!user) return res.status(404).json({ message: "Fixter not found" });
  if (typeof req.body.isActive !== "boolean") {
    return res.status(400).json({ message: "isActive must be boolean" });
  }
  user.isActive = req.body.isActive;
  if (!user.isActive) user.isDefaultFixter = false;
  await user.save();
  return res.json({ fixter: fixterDTO(user) });
});

router.patch("/:id/default", async (req, res) => {
  try {
    const isDefault = req.body.isDefault === true;
    const user = await User.findOne({ _id: req.params.id, role: "employee" });
    if (!user) return res.status(404).json({ message: "Fixter not found" });
    if (isDefault && user.isActive === false) {
      return res.status(400).json({ message: "Inactive employee cannot be default" });
    }

    await User.updateMany(
      { role: "employee", isDefaultFixter: true },
      { $set: { isDefaultFixter: false } }
    );
    if (isDefault) {
      await User.updateOne(
        { _id: user._id },
        { $set: { isDefaultFixter: true } }
      );
    }
    const rows = await User.find({ role: "employee" }).sort({ createdAt: -1 });
    return res.json({ fixters: rows.map(fixterDTO) });
  } catch (error) {
    console.error("Set default Fixter failed:", error);
    return res.status(500).json({ message: "Failed to update default Fixter" });
  }
});

module.exports = router;
