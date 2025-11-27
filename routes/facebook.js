// routes/facebook.js
const router = require("express").Router();
router.post("/capi", require("../controllers/facebookCapi"));
module.exports = router;
