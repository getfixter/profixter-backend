const mongoose = require("mongoose");
const { dateValidator } = require("../utils/availabilityValidation");

const CalendarDayNoteSchema = new mongoose.Schema(
  {
    date: {
      type: String,
      required: true,
      unique: true,
      index: true,
      validate: { validator: dateValidator, message: "Date must be YYYY-MM-DD" },
    },
    note: { type: String, trim: true, maxlength: 5000, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CalendarDayNote", CalendarDayNoteSchema);
