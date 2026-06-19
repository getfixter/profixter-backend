const mongoose = require("mongoose");

function isTransactionUnsupported(error) {
  return (
    error?.code === 20 ||
    error?.codeName === "IllegalOperation" ||
    /transaction numbers are only allowed/i.test(String(error?.message || "")) ||
    /transactions are not supported/i.test(String(error?.message || ""))
  );
}

async function runReservationTransaction(
  operation,
  { mongooseInstance = mongoose, logger = console } = {}
) {
  const session = await mongooseInstance.startSession();
  let result;
  try {
    await session.withTransaction(
      async () => {
        result = await operation(session);
      },
      {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
      }
    );
    return result;
  } catch (error) {
    if (isTransactionUnsupported(error)) {
      logger.warn(
        "Reservation write aborted: MongoDB transactions are unavailable. No non-transaction fallback was used."
      );
      const wrapped = new Error(
        "Reservation writes require MongoDB transaction support"
      );
      wrapped.code = "TRANSACTIONS_UNAVAILABLE";
      wrapped.statusCode = 503;
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

module.exports = {
  isTransactionUnsupported,
  runReservationTransaction,
};
