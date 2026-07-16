const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Project = require("../models/Project");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

function frontendSource(relativePath) {
  return fs.readFileSync(
    path.join(__dirname, "..", "..", "FrontEnd", relativePath),
    "utf8"
  );
}

const projectsRoute = source("routes/projects.js");
const estimatesRoute = source("routes/adminEstimates.js");
const contractsRoute = source("routes/adminContracts.js");
const projectsModule = frontendSource("app/components/admin/ProjectsModule.tsx");
const adminService = frontendSource("lib/admin-service.ts");

assert(Project.schema.path("isDeleted"), "Project must have a soft-delete flag");
assert(Project.schema.path("deletedAt"), "Project must keep deletion timestamp");
assert(Project.schema.path("deletedBy"), "Project must keep deletion actor");
assert(Project.schema.path("deleteReason"), "Project must allow an optional deletion reason");
assert.strictEqual(
  Project.schema.path("projectNumber").options.immutable,
  true,
  "Deleted project numbers must not be reusable by editing existing records"
);

assert.match(
  projectsRoute,
  /isDeleted:\s*\{\s*\$ne:\s*true\s*\}/,
  "Normal project queries must exclude deleted records while preserving legacy records"
);
assert.doesNotMatch(
  projectsRoute,
  /findByIdAndDelete|Project\.delete|Contract\.delete|Estimate\.delete|deletePublicObjects/,
  "Project deletion must not hard-delete projects, related records, or S3 objects"
);
assert.doesNotMatch(
  projectsRoute,
  /contract history and cannot be deleted|estimates before deleting the project/,
  "Contract or estimate history must not block project soft-delete"
);
assert.match(projectsRoute, /projectDeletionSummary/, "Delete route must inspect related records");
assert.match(projectsRoute, /Estimate\.countDocuments/, "Delete summary must count estimates");
assert.match(projectsRoute, /Contract\.find/, "Delete summary must inspect contracts");
assert.match(projectsRoute, /generatedPdfCount/, "Delete summary must preserve generated PDF metadata");
assert.match(projectsRoute, /signedPdfCount/, "Delete summary must preserve signed PDF metadata");
assert.match(projectsRoute, /requiresDeleteConfirmation/, "Delete route must require DELETE for related records");
assert.match(projectsRoute, /Project already deleted/, "Double-delete must return a clear idempotent response");
assert.match(projectsRoute, /router\.post\("\/:id\/restore"/, "Project restore endpoint must exist");
assert.match(projectsRoute, /deletedBy:\s*req\.user\.id/, "Delete route must record the deleting admin");
assert.match(
  projectsRoute,
  /router\.use\(auth,\s*\.\.\.requirePermission\(PERMISSIONS\.ADMIN\)\)/,
  "Project delete and restore routes must remain admin-protected"
);
assert.doesNotMatch(
  projectsRoute,
  /User\.findByIdAndUpdate|Subscription\.findByIdAndUpdate|Subscription\.delete/,
  "Project soft-delete must not mutate customers or memberships"
);

assert.match(
  estimatesRoute,
  /Parent project has been deleted/,
  "Estimate APIs must return a clear deleted-project response"
);
assert.match(
  estimatesRoute,
  /\$nin:\s*deletedProjects\.map/,
  "Normal estimate lists must exclude estimates whose projects are deleted"
);

assert.match(
  contractsRoute,
  /parentProjectDeletedAt/,
  "Contract audit responses must expose parent project deletion metadata"
);
assert.match(
  contractsRoute,
  /getProjectOr404\(req\.params\.projectId,\s*res,\s*\{\s*allowDeleted:\s*true\s*\}/,
  "Authorized contract list must support deleted parent projects for audit/recovery"
);
assert.match(
  contractsRoute,
  /getContractForProjectOr404\(req\.params\.id,\s*req,\s*res,\s*\{\s*allowDeleted:\s*true\s*\}/,
  "Historical contract downloads must remain available for deleted parent projects"
);
assert.doesNotMatch(
  contractsRoute,
  /deletePublicObjects/,
  "Contract routes must not delete generated or signed S3 files for project soft-delete"
);

assert.match(
  adminService,
  /getProjectDeletionSummary/,
  "Frontend service must load delete summary before confirmation"
);
assert.match(projectsModule, /Type <span[^>]*>DELETE<\/span> to confirm/, "Modal must require DELETE");
assert.match(
  projectsModule,
  /contracts, signed files, estimates, and history will be preserved for recordkeeping/,
  "Modal must explain preserved legal records"
);
assert.match(
  projectsModule,
  /Project deleted\. Contracts and saved records were preserved\./,
  "Frontend must show the required success message"
);
assert.doesNotMatch(
  projectsModule,
  /permanently delete|Permanently Delete/i,
  "Project soft-delete modal must not use permanent-delete wording"
);

console.log("Project soft-delete safety tests passed.");
