// 📁 models/Request.js
const mongoose = require("mongoose");

const RequestSchema = new mongoose.Schema({
  name: String,
  email: String,
  password: String,
  phone: String,
  address: String,
  city: String,
  state: String,
  zip: String,
  county: String,
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Request", RequestSchema);
