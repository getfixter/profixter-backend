const mongoose = require("mongoose");

const FeedbackSubmissionSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },
    message: { type: String, trim: true, required: true },
    sourcePage: { type: String, trim: true, default: "/feedback" },
    attachments: [
      {
        filename: String,
        contentType: String,
        size: Number,
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  "FeedbackSubmission",
  FeedbackSubmissionSchema
);
