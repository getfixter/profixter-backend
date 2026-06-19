require("dotenv").config();
const mongoose = require("mongoose");
const CapacityOverride = require("../models/CapacityOverride");

async function run() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  const write = process.argv.includes("--write");
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });

  const duplicates = await CapacityOverride.aggregate([
    {
      $group: {
        _id: {
          scopeType: "$scopeType",
          technicianId: "$technicianId",
          date: "$date",
          startTime: "$startTime",
          endTime: "$endTime",
        },
        ids: { $push: "$_id" },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  console.log(
    `${duplicates.length} duplicate capacity-override key(s) found${write ? "" : " (dry run)"}`
  );
  if (write) {
    for (const duplicate of duplicates) {
      const records = await CapacityOverride.find({
        _id: { $in: duplicate.ids },
      })
        .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
        .select("_id");
      await CapacityOverride.deleteMany({
        _id: { $in: records.slice(1).map((record) => record._id) },
      });
    }
    console.log("Duplicate capacity overrides removed; newest record retained");
  }
}

run()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
