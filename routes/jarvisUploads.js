const express = require("express");
const fs = require("fs-extra");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const { askJarvis } = require("../src/aiCommanderGhl/jarvisIntentRouter");
const { redact } = require("../src/aiCommanderGhl/ghlClient");
const JarvisConversation = require("../src/aiCommanderGhl/jarvisConversation.model");

const router = express.Router();

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const MAX_FILES_PER_ANALYSIS = 20;
const TEMP_TTL_HOURS = Number(process.env.JARVIS_UPLOAD_TTL_HOURS || 24);
const LOCAL_UPLOAD_ROOT =
  process.env.JARVIS_UPLOAD_TMP_DIR ||
  path.join(process.cwd(), "tmp", "jarvis-uploads");
const S3_BUCKET = process.env.S3_BUCKET;
const S3_PREFIX = (process.env.S3_PREFIX || "uploads").replace(/^\/+|\/+$/g, "");

const ALLOWED_EXTENSIONS = new Set([
  ".csv",
  ".docx",
  ".jpg",
  ".jpeg",
  ".json",
  ".pdf",
  ".png",
  ".txt",
  ".webp",
  ".xlsx",
]);

const MIME_BY_EXTENSION = {
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function safeName(name) {
  return String(name || "upload")
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 140) || "upload";
}

function extensionFor(fileName) {
  return path.extname(String(fileName || "")).toLowerCase();
}

function dateFolder(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getS3Helpers() {
  if (!S3_BUCKET) return null;
  return require("../utils/s3");
}

function uploadFilter(_req, file, cb) {
  const ext = extensionFor(file.originalname);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    const error = new Error(
      "Jarvis can accept CSV, Excel, PDF, TXT, DOCX, images, and JSON files."
    );
    error.status = 400;
    return cb(error);
  }
  return cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_FILES_PER_ANALYSIS,
  },
  fileFilter: uploadFilter,
});

const receiveFiles = upload.array("files", MAX_FILES_PER_ANALYSIS);

function statusForError(error) {
  const status = Number(error?.statusCode || error?.status || 500);
  return status >= 400 && status < 600 ? status : 500;
}

function cleanString(value) {
  return String(value ?? "").trim();
}

function escapeRegex(value) {
  return cleanString(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleFromMessages(messages = []) {
  const firstUserMessage = messages.find(
    (message) => message?.role === "user" && cleanString(message.text)
  );
  const text = cleanString(firstUserMessage?.text);
  if (/roof|siding/i.test(text) && /csv|file|sync|tag|audit/i.test(text)) {
    return "Roofing/Siding CSV Sync";
  }
  return text
    ? text.replace(/\s+/g, " ").split(" ").slice(0, 8).join(" ").slice(0, 80)
    : "New Jarvis Chat";
}

function safeConversationId(value) {
  const clean = cleanString(value);
  if (!/^[a-zA-Z0-9_-]{6,120}$/.test(clean)) {
    const error = new Error("Invalid Jarvis conversation id.");
    error.statusCode = 400;
    throw error;
  }
  return clean;
}

function sanitizeMessages(messages) {
  return (Array.isArray(messages) ? messages : []).slice(-200).map((message) => {
    const safe = redact({
      clientId: cleanString(message?.id || message?.clientId).slice(0, 120),
      role: message?.role === "user" ? "user" : "jarvis",
      kind: cleanString(message?.kind || "text"),
      text: cleanString(message?.text).slice(0, 20000),
      intent: cleanString(message?.intent).slice(0, 80),
      sources: Array.isArray(message?.sources) ? message.sources.map(cleanString).slice(0, 25) : [],
      files: Array.isArray(message?.files) ? message.files.slice(0, 30) : [],
      plan: message?.plan || null,
      data: message?.data || null,
      error: message?.error || null,
      createdAt: message?.createdAt || new Date(),
    });
    if (!["text", "brief", "plan", "answer", "error"].includes(safe.kind)) {
      safe.kind = "text";
    }
    return safe;
  });
}

function workflowIdsFromValue(value, ids = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => workflowIdsFromValue(item, ids));
    return ids;
  }
  if (!value || typeof value !== "object") return ids;
  const jobId = cleanString(value.jobId || value.workflowJob?.jobId);
  if (jobId) ids.add(jobId);
  Object.values(value).forEach((item) => workflowIdsFromValue(item, ids));
  return ids;
}

function uploadBatchIdsFromMessages(messages) {
  const ids = new Set();
  messages.forEach((message) => {
    (Array.isArray(message.files) ? message.files : []).forEach((file) => {
      const uploadId = cleanString(file?.uploadId);
      if (uploadId) ids.add(uploadId);
    });
  });
  return [...ids];
}

function publicConversation(conversation) {
  if (!conversation) return null;
  return {
    id: conversation.conversationId,
    conversationId: conversation.conversationId,
    title: conversation.title,
    subtitle: conversation.subtitle,
    messages: conversation.messages || [],
    executionByPlanId: conversation.executionByPlanId || {},
    errorByPlanId: conversation.errorByPlanId || {},
    canceledPlans: conversation.canceledPlans || {},
    uploadBatchIds: conversation.uploadBatchIds || [],
    workflowJobIds: conversation.workflowJobIds || [],
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastMessageAt: conversation.lastMessageAt,
  };
}

function publicConversationSummary(conversation) {
  return {
    id: conversation.conversationId,
    conversationId: conversation.conversationId,
    title: conversation.title,
    subtitle: conversation.subtitle,
    messageCount: Array.isArray(conversation.messages) ? conversation.messages.length : 0,
    workflowJobIds: conversation.workflowJobIds || [],
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastMessageAt: conversation.lastMessageAt,
  };
}

async function saveConversation({ adminUserId, conversationId, body }) {
  const messages = sanitizeMessages(body.messages);
  const executionByPlanId = redact(body.executionByPlanId || {});
  const errorByPlanId = redact(body.errorByPlanId || {});
  const canceledPlans = redact(body.canceledPlans || {});
  const title = cleanString(body.title).slice(0, 100) || titleFromMessages(messages);
  const subtitle = cleanString(body.subtitle).slice(0, 120);
  const lastMessageAt = messages.length
    ? new Date(messages[messages.length - 1].createdAt || Date.now())
    : new Date();

  const workflowJobIds = [
    ...workflowIdsFromValue(executionByPlanId),
    ...workflowIdsFromValue(messages),
  ].slice(0, 100);

  const conversation = await JarvisConversation.findOneAndUpdate(
    { adminUserId, conversationId },
    {
      $set: {
        title,
        subtitle,
        messages,
        executionByPlanId,
        errorByPlanId,
        canceledPlans,
        uploadBatchIds: uploadBatchIdsFromMessages(messages),
        workflowJobIds,
        lastMessageAt,
      },
      $setOnInsert: { adminUserId, conversationId },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  return publicConversation(conversation);
}

function handleUploadMiddleware(req, res, next) {
  receiveFiles(req, res, (error) => {
    if (!error) return next();

    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          message: "Each Jarvis attachment must be 50MB or smaller.",
          maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
        });
      }
      if (error.code === "LIMIT_FILE_COUNT") {
        return res.status(400).json({
          message: `Jarvis can analyze up to ${MAX_FILES_PER_ANALYSIS} files at once.`,
          maxFiles: MAX_FILES_PER_ANALYSIS,
        });
      }
      return res.status(400).json({ message: error.message });
    }

    return res.status(error.status || 400).json({ message: error.message });
  });
}

async function storeLocalFile({ batchId, uploadId, file, storedName, folder }) {
  const relativePath = path.posix.join(folder, batchId, `${uploadId}-${storedName}`);
  const absolutePath = path.join(LOCAL_UPLOAD_ROOT, relativePath);
  await fs.ensureDir(path.dirname(absolutePath));
  await fs.writeFile(absolutePath, file.buffer);
  return {
    storage: "local",
    tempRef: `local:${relativePath}`,
    storageKey: relativePath,
  };
}

async function storeS3File({ batchId, uploadId, file, storedName, folder, contentType }) {
  const { putPublicObject } = getS3Helpers();
  const key = path.posix.join(
    S3_PREFIX,
    "jarvis-temp",
    folder,
    batchId,
    `${uploadId}-${storedName}`
  );

  await putPublicObject({
    Bucket: S3_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: contentType,
    CacheControl: "private, max-age=0, no-store",
  });

  return {
    storage: "s3",
    tempRef: `s3:${key}`,
    storageKey: key,
  };
}

function expiresAtFrom(now) {
  return new Date(now.getTime() + TEMP_TTL_HOURS * 60 * 60 * 1000).toISOString();
}

router.get(
  "/conversations",
  auth,
  ...requirePermission(PERMISSIONS.ADMIN),
  async (req, res) => {
    try {
      const search = cleanString(req.query.search);
      const limit = Math.max(1, Math.min(50, Number(req.query.limit || 30)));
      const query = { adminUserId: req.user.id };
      if (search) {
        const pattern = escapeRegex(search);
        query.$or = [
          { title: { $regex: pattern, $options: "i" } },
          { "messages.text": { $regex: pattern, $options: "i" } },
        ];
      }
      const conversations = await JarvisConversation.find(query)
        .sort({ lastMessageAt: -1, updatedAt: -1 })
        .limit(limit)
        .lean();
      return res.json({ conversations: conversations.map(publicConversationSummary) });
    } catch (error) {
      return res.status(statusForError(error)).json({
        message: error?.message || "Failed to load Jarvis conversations.",
      });
    }
  }
);

router.post(
  "/conversations",
  auth,
  ...requirePermission(PERMISSIONS.ADMIN),
  async (req, res) => {
    try {
      const conversationId = safeConversationId(req.body?.conversationId || crypto.randomUUID());
      const conversation = await saveConversation({
        adminUserId: req.user.id,
        conversationId,
        body: req.body || {},
      });
      return res.status(201).json({ conversation });
    } catch (error) {
      return res.status(statusForError(error)).json({
        message: error?.message || "Failed to save Jarvis conversation.",
      });
    }
  }
);

router.get(
  "/conversations/:conversationId",
  auth,
  ...requirePermission(PERMISSIONS.ADMIN),
  async (req, res) => {
    try {
      const conversationId = safeConversationId(req.params.conversationId);
      const conversation = await JarvisConversation.findOne({
        adminUserId: req.user.id,
        conversationId,
      }).lean();
      if (!conversation) return res.status(404).json({ message: "Jarvis conversation not found." });
      return res.json({ conversation: publicConversation(conversation) });
    } catch (error) {
      return res.status(statusForError(error)).json({
        message: error?.message || "Failed to load Jarvis conversation.",
      });
    }
  }
);

router.put(
  "/conversations/:conversationId",
  auth,
  ...requirePermission(PERMISSIONS.ADMIN),
  async (req, res) => {
    try {
      const conversationId = safeConversationId(req.params.conversationId);
      const conversation = await saveConversation({
        adminUserId: req.user.id,
        conversationId,
        body: req.body || {},
      });
      return res.json({ conversation });
    } catch (error) {
      return res.status(statusForError(error)).json({
        message: error?.message || "Failed to save Jarvis conversation.",
      });
    }
  }
);

router.post(
  "/uploads",
  auth,
  ...requirePermission(PERMISSIONS.ADMIN),
  handleUploadMiddleware,
  async (req, res, next) => {
    try {
      const files = Array.isArray(req.files) ? req.files : [];
      const prompt = String(req.body?.prompt || "").trim();

      if (!files.length) {
        return res.status(400).json({ message: "Attach at least one file for Jarvis." });
      }

      const now = new Date();
      const batchId = crypto.randomUUID();
      const folder = dateFolder(now);
      const expiresAt = expiresAtFrom(now);

      const storedFiles = [];

      for (const file of files) {
        if (!file.buffer?.length) {
          return res.status(400).json({
            message: `The file "${file.originalname}" is empty and could not be attached.`,
          });
        }

        const ext = extensionFor(file.originalname);
        const uploadId = crypto.randomUUID();
        const storedName = safeName(file.originalname);
        const contentType = file.mimetype || MIME_BY_EXTENSION[ext] || "application/octet-stream";
        const storageResult = S3_BUCKET
          ? await storeS3File({
              batchId,
              uploadId,
              file,
              storedName,
              folder,
              contentType,
            })
          : await storeLocalFile({
              batchId,
              uploadId,
              file,
              storedName,
              folder,
            });

        storedFiles.push({
          uploadId,
          originalName: file.originalname,
          displayName: storedName,
          mimeType: contentType,
          extension: ext.replace(/^\./, ""),
          size: file.size,
          uploadedAt: now.toISOString(),
          expiresAt,
          ...storageResult,
        });
      }

      return res.json({
        uploadBatchId: batchId,
        prompt,
        files: storedFiles,
        temporary: true,
        expiresAt,
        maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  "/ask",
  auth,
  ...requirePermission(PERMISSIONS.ADMIN),
  async (req, res) => {
    try {
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        return res.status(400).json({ message: "Request body must be a JSON object." });
      }

      const result = await askJarvis({
        message: req.body.message,
        adminUserId: req.user.id,
        uploadBatchId: req.body.uploadBatchId,
        files: Array.isArray(req.body.files) ? req.body.files : [],
      });
      return res.json(result);
    } catch (error) {
      console.error("Jarvis ask failed", {
        adminUserId: req.user?.id || null,
        statusCode: statusForError(error),
        message: error?.message || String(error),
        stack: error?.stack || null,
      });
      return res.status(statusForError(error)).json({
        message: error?.message || "Jarvis could not answer that request.",
      });
    }
  }
);

module.exports = router;
