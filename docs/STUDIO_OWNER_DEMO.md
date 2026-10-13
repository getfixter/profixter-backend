# Shower Studio - 10-minute owner demo

## On your phone and tablet (the homeowner experience)

1. On this computer, double-click
   `C:\Users\Taras\profixter-studio\Open Shower Studio demo (phone and tablet).cmd`.
2. Wait 3-4 minutes (it builds a fast version of the site). If Windows asks
   whether Node.js may use the network, allow **Private networks**.
3. The window shows an address like `http://192.168.1.158:3098/shower-studio`.
   Type it into Safari/Chrome on your phone or iPad - they must be on the same
   Wi-Fi as this computer. It also opens here in your browser.
4. Design a bathtub or a walk-in shower and send a request with test details.
   The black window shows "[caught on this computer, not sent]" for each one.

What you see: a curated set (4 wall styles in 4 colours, 2 tubs, 2 shower
bases, Delta and Moen faucet packages, doors, a rod and extras) with **DEMO
prices** and a DEMO banner. Nothing reaches customers, email, Profixter's
database or AWS; closing the window erases everything. The same window also
gives Admin at `.../signin` (owner@studio-qa.test / studio-demo).

If the phone cannot open the address: check it is on the same Wi-Fi (not
cellular), and in Windows Security → Firewall & network protection → Allow an
app, tick Node.js for Private networks.

**Start:** double-click `C:\Users\Taras\profixter-studio\Open Shower Studio demo.cmd`.
Wait 1-2 minutes; the browser opens the Studio. Everything is test data on your
computer (test prices, test staff, emails caught locally). Close the black
window to stop; it erases everything.

## As a customer (try it on your phone-sized browser window too)

1. Tap **Walk-in shower**. The new shower appears on the example bathroom,
   with the badge "Example bathroom · standard 60" x 30" size".
2. Tap through **Walls / Base / Faucet / Door / Extras**. The picture and the
   estimated total change with each tap. Try **Bathtub** at the top.
3. Optional: "I know my measurements", or "Try it on a photo of my bathroom".
4. **View design & price**: slide before/after; the price says *Estimated
   total* and what it is based on.
5. **Request installation**: fill in any test name/phone/email/ZIP, send.

## As the owner (Admin)

Sign in at `http://127.0.0.1:3098/signin` with `owner@studio-qa.test`,
password `studio-demo`. In the Admin tab row, scroll right to
**Shower Studio** and **Studio Catalog** (or type "Studio" in the Admin search).

1. **Shower Studio**: your request is there ("example, no photo · not
   measured"). Open it: change a measurement, tick *Measured on site*, add
   *Valve relocation*, **Save**, **Create proposal**.
2. **Projects**: the new Bathroom project with its estimate; the contract and
   signature work exactly as today.
3. **Leads**: the request is also there, with **Open in Shower Studio**.
4. **Studio Catalog**: open any product - photos, texture, what it fits,
   specifications, price, Publish/Unpublish. **Prices & packages**: base prices,
   adders, packages, the employee discount limit. **Completeness**: what is
   still missing.

Other test logins (same password): `sam@studio-qa.test` (salesperson),
`pat@studio-qa.test` (salesperson who may discount), `cat@studio-qa.test`
(catalog & prices only), `otto@studio-qa.test` (no Studio access).
