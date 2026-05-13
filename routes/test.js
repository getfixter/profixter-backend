const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

router.get('/ping', async (req, res) => {
  try {
    const result = await mongoose.connection.db.admin().ping();
    res.json({ msg: "✅ Database connection is successful", result });
  } catch (error) {
    res.status(500).json({ msg: "❌ Database connection failed", error });
  }
});

module.exports = router;
