# Shower Studio - 10-minute owner demo

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
