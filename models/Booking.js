const mongoose = require('mongoose');

const BookingSchema = new mongoose.Schema({
  bookingNumber: { type: String, required: true },
  date: { type: Date, required: true },
  service: { type: String, required: true },

  user:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userId: { type: String, required: true },
  name:   { type: String, required: true },

  addressId: { type: mongoose.Schema.Types.ObjectId, default: null },

  address: { type: String, required: true, default: "" },
  city:    { type: String, default: "" },
  state:   { type: String, default: "" },
  zip:     { type: String, default: "" },
  county:  { type: String, default: "" },

  phone: { type: String, required: true },
  email: { type: String, required: true },

  // kept for display/legacy; not used for gating after create
  subscription: { type: String, required: true },

  note:   { type: String, required: true },
  images: [{ type: String }],

  status: { type: String, default: "Pending" }, // Pending | Confirmed | Completed | Canceled | ...
  statusHistory: [{ status: String, date: Date }],
  cancellationReason: { type: String },
  paymentStatus: { type: String },
  feedback: { type: String },
  assignedHandyman: { type: String },
}, { timestamps: true });

/* Useful indexes */
BookingSchema.index({ user: 1, addressId: 1, date: 1, status: 1 });
BookingSchema.index({ date: 1 });
BookingSchema.index({ bookingNumber: 1 }, { unique: false });

module.exports = mongoose.model('Booking', BookingSchema);
