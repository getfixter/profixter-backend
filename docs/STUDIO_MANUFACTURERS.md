# Shower Studio - manufacturer catalogs (Swan first)

Admin → Studio Catalog → **Manufacturers**. Owner only by default (the
"Shower Studio catalog & prices" section, which no employee has).

Everything here is private. Shower Studio is still dark (`STUDIO_PUBLIC_ENABLED`
unset), and even when it goes public, only products you publish (with your own
selling price and a compatibility review) reach customers.

## How it fits together

```
Swan price file (.xlsx)
   │  upload → PREVIEW (nothing changes) → you confirm → IMPORT
   ▼
Manufacturer catalog  (StudioSupplierItem: one record per Swan part number, ~3,700)
   │  you pick variants → "Add to Studio as drafts"
   ▼
Studio products       (StudioProduct, SKU = Swan part number: draft, no price, compatibility unverified)
   │  you set material cost + selling price, review compatibility, publish (when public launch is approved)
   ▼
Designer + estimates  (the existing Shower Studio; nothing new to learn)
```

- The manufacturer catalog is a reference price book, not something
  customers see. Thousands of Swan variants there do not clutter the
  designer: only what you add becomes a Studio product.
- Matching is by **manufacturer + Sellable Part Number** (e.g. `TSMK843062.221`
  = model TSMK84-3062 in Carrara). Re-importing the same file changes nothing;
  a new file updates only what changed. Nothing is ever deleted.

## Updating the Swan catalog (no programming)

1. Download the newest **Swan Electronic Product File (EPF)** from
   swanstone.com → Pro's Corner → Resources.
2. Admin → Studio Catalog → Manufacturers → **Import price file** → choose the file.
3. Read the preview: new / changed / list-price changes / discontinued / no
   longer listed / which of *your* Studio products are affected, plus notes
   about the file (duplicates, conflicts).
4. Untick categories you don't want yet, then **Import**. Takes seconds.

What an import never does: change your selling prices or material costs,
publish or unpublish anything, delete anything. When the manufacturer changes
something on a product you use, the product gets a "changes to review" note
(e.g. *List price changed from $3,185.00 to $3,299.00. Your selling price was
not changed.*). A product Swan discontinues is marked, not removed, and cannot
be published until you decide.

The import history keeps every upload (file, date, what changed).

## Prices - three separate numbers

| Field | Whose | Where it comes from | Customers see it? |
|---|---|---|---|
| Manufacturer list price | Swan | the price file, refreshed by each import (history kept) | never |
| Material cost | yours | you type it | never |
| Selling price | yours | you type it | only inside a total |

The list price is **not** treated as your cost, and no selling price is ever
calculated from it. A Swan product cannot be published, and is never priced in
a customer quote, until you set a selling price. Per-estimate overrides and
discounts work as before (Shower Studio → design → price adjustments).

## Adding products to the Studio

**One product:** open it in Manufacturers → Products (search a part number,
or a series → model → colour) and press **Add to Studio**. It becomes a
private draft with the manufacturer's specifications, size and colour, and
the editor opens. Already added: "Already in Studio → Open in editor". Not
drawable (vanity tops, sinks, single panels, corner bases...): the page says
why. "Add all N colors" on a model adds every colour of that size at once.

**Everything eligible:** Manufacturers → Products → **Add eligible products
to Studio**. The preview shows, per category: new, already in the Studio, not
drawable (with reasons), missing specifications, missing photo links. Pick
categories and confirm. Swan file of 2026-10-01: **1,804 eligible** (1,370
wall kits, 236 bases, 30 tubs, 106 tub/shower units, 12 shower units, 49
accessories; plus the integral walls of the 118 one-piece units) and 1,868
that stay in the library. Adding all of them takes a few seconds; it runs in
the background, and running it again adds only what is missing (an
interrupted run is marked and simply started again).

Both use the same code path, keyed on the manufacturer part number: a
product is never added twice, and nothing you set is ever overwritten.

## Getting a product ready to publish

Studio Catalog → **Products** is the catalog manager: products grouped into
families (series → size → colour), with search (an exact SKU / part number
jumps straight to it), source, category and readiness filters (drafts, ready
for review, ready to publish, published, missing price, missing photo,
compatibility unverified, preview to check, manufacturer changes, archived),
and bulk changes (publish ready ones, back to draft, archive drafts, mark
compatibility reviewed with a note, show/hide on the website, feature).

A manufacturer product can be published only when its checklist is complete:

1. your selling price;
2. a photo customers may see (your upload, or the manufacturer's copied after
   image rights are confirmed);
3. compatibility reviewed (the editor's **Show what it fits** lists the
   bases/walls/doors in your catalog it pairs with under the designer's own
   fit rules, and what to confirm: drain position, threshold, installation);
4. product information approved (name, description, specifications);
5. illustrative preview checked (any estimated detail is listed);
6. still sold by the manufacturer.

Bulk publishing runs the same checklist per product and skips (with the
reason) any that are not ready. Hand-made products keep the old rules.

The editor also shows the family's other sizes and colours (one click to
switch), and each product's image status: photos customers may see,
manufacturer images (and their rights), texture source (yours / manufacturer
/ approximation), and whether the preview needs checking.

## Product families, sizes and colours

Variants are grouped as **category → series → model (size / drain side) →
colour**, e.g. *Swanstone Traditional Subway Tile Glue up Shower Wall Kit →
TSMK84-3062 (62″ × 30″ × 84″) → Carrara / Ash Gray / …*. Search finds a model
number with or without dashes (`TSMK84-3062`, `TSMK843062`) or a UPC.

The designer (staff and public) shows **one card per family**; choosing it
shows the sizes that fit the measured alcove and the colours of that size as
chips. Only combinations that pass the fit rules are offered, and the public
Studio offers only published products.

## What the designer can draw

| Swan category | Drawn? | How |
|---|---|---|
| Wall kits (3+ pieces) | yes | Swan's published pattern sizes (Traditional 24×12, Modern 24×6, Metro 8×4, Vertical 3×12, Smooth), colour measured from Swan's swatch, kit size from the file. "Bathtub and Shower" kits work over both. |
| Single/double wall panels, trims | no | sold with kits; kept in the catalog |
| Rectangular/square alcove shower bases | yes | size, height, threshold (when the file gives it), drain side from the file |
| Corner / neo-angle bases | no | the designer draws alcoves only |
| Alcove bathtubs | yes | size, rim height, sump depth from the file |
| Tub/shower and shower units (one piece) | yes, approximately | the unit as a base plus its own smooth walls (a linked "integral walls" product, only selectable with that unit, $0 because it is part of the unit's price) |
| Straight grab bars, folding seats, corner shelves / soap dishes | yes | standard shapes |
| Other accessories, vanity tops, sinks | no | kept in the catalog for later; can be added to an estimate as an adder |

Everything drawn from Swan products is marked **Illustrative**. Each product
lists its approximations (colour, drain position, generic base shapes, the
wall-kit trim range). Swan does not publish 3D models or seamless textures
for its shower products (the file's CAD column has STEP engineering files,
plus GLB models only for utility sinks), so no product geometry is invented.

**Compatibility** (which walls go on which bases, which doors fit) is not in
the price file. Every Swan product starts *unverified*; review it against
Swan's drawings, then mark it reviewed. Required to publish. The wall-kit fit
range (kit size, trimmed down by up to 6″ by default) is an assumption you can
change under Image rights & links → Wall kit sizing.

## Photos, swatches, textures, drawings, 3D - five different things

| | What it is | Here |
|---|---|---|
| Product photo | a picture of the product | Swan's links, previewed in Admin; your own uploads or copies (after rights) are what customers see |
| Colour swatch | a picture of a material sample, to look at | Swan's official swatches (previewed); you may upload your own |
| Texture | a seamless, repeatable image at real size, for drawing walls | only if supplied - uploaded per colour, labelled *manufacturer* or *approximation for testing* |
| Technical drawing / guide | PDFs | Swan's links (Admin) |
| 3D model / CAD | geometry files | Swan's links (Admin); not used for drawing |

A bathroom photo is never used as a wall texture.

## Image rights

Swan's images are on public websites, but that does not make them free to
reuse. Until you record permission (Manufacturers → Image rights & links →
"Confirmed: I have permission", with who granted it and what it covers):

- Swan images are shown **in Admin only**, loaded from Swan's own site (not
  copied, not stored by Profixter), so you can evaluate them;
- they never appear in the public Studio or customer pages;
- "Use this photo" on a product refuses to copy them.

After you confirm, "Use" copies a photo into Profixter's private storage,
re-encoded and optimized, once per image, and attaches it to the product.
Or upload images you are licensed to use, as before.

**What to ask Swan (dealer rep / marketing):**
1. Written permission to use Swan product photos, colour swatches and
   technical drawings on profixter.com, in the online designer and in
   customer proposals (and whether a credit line is required).
2. High-resolution, **seamless texture images** of each Swanstone colour
   (Carrara, Ash Gray, Birch, Limestone, Ice, Tahiti White, Coastal Sands,
   Mountain Mist, Bisque, White) with the real-world size of one repeat.
3. Wall pattern specifications: grout line width and colour per pattern; the
   Novaline subway tile size.
4. Compatibility tables: which wall kits pair with which shower bases and
   tubs (and the trim-to-fit range of each kit); door compatibility
   (threshold widths for the pans the file leaves blank).
5. 3D models (glTF/GLB or OBJ) of shower bases, tubs and tub/shower units, if
   they have them (the EPF only links STEP files for showers).
6. Dealer cost / price sheet - the EPF list price is not your cost.

## Link checks

Manufacturers → Image rights & links → **Check links** checks every image,
drawing, guide and CAD link (videos excluded) from the server, only on Swan's
own hosts, and shows *working / broken / unreachable* per link. Results also
appear next to each image in the variant view.

Swan file of 2026-10-01 (checked 2026-10-12): 4,012 distinct links; product
photos 3,473 of 3,517 working (4 return 404; 40 on images.salsify.com did not
answer this machine and may be fine); drawings 287/288, guides 52/53, CAD
139/148, 3D 6/6. 3,368 of 3,672 variants have a working photo; 277 have no
photo link at all.

## Adding another manufacturer (e.g. MAAX)

Code, one adapter file: `utils/studio/manufacturers/<brand>.js` (sheet names,
series naming, colour table, patterns, what the designer can draw, allowed
media hosts), registered in `utils/studio/manufacturers/index.js`. MAAX and
DreamLine are American Bath Group brands like Swan; if their file is also an
ABG "Electronic Product File", the parser `abgEpf.js` is reused as is.
Everything else (imports, history, browsing, adding to the Studio, prices,
rights, link checks, Admin pages) works for any registered manufacturer.

## Technical reference

- Models: `StudioSupplierItem`, `StudioCatalogImport`, `StudioManufacturer`,
  `StudioMediaCheck`; `StudioProduct` gained `source`, `externalMedia`,
  `compatibility`, `pricing.costCents`; `StudioAsset` kinds photo / texture / swatch.
- Routes: `/api/admin/studio/manufacturers/...` (routes/adminStudioManufacturers.js),
  `POST /api/admin/studio/products/:id/media/copy`, `.../source/reviewed`.
- Public routes are unchanged; `toEngineCatalog` never gives the public catalog
  manufacturer links, costs or list prices (tested).
- Upload limits: .xlsx only, 20 MB, 150,000 rows; cell values only (no formulas run).
- The uploaded file is stored privately under `private/studio/imports/` so
  the confirmed import applies exactly the previewed file.
- Tests: `scripts/test_studio_manufacturer_import.js` (CI; with the real file in
  `catalog-imports/` it also imports the whole workbook) and
  `scripts/test_studio_manufacturer_ui.js` (browser walk-through, local).
