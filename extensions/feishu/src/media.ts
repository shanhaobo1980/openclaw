import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { fileURLToPath } from "url";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { resolveReceiveIdType, normalizeFeishuTarget } from "./targets.js";

/** Sanitize a key/name so it cannot escape the temp directory. */
function sanitizeTempComponent(value: string): string {
  return value.replace(/[/\\:*?"<>|]/g, "_").replace(/\.\./g, "_");
}

/** Generate a collision-resistant temp file path. */
function makeTempPath(prefix: string, suffix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}_${crypto.randomUUID()}_${sanitizeTempComponent(suffix)}`,
  );
}

/**
 * Extract a Buffer from a Feishu SDK response, which may be in various formats.
 * Handles: Buffer, ArrayBuffer, data wrapper, ReadableStream, writeFile, AsyncIterator, Readable.
 */
async function extractBufferFromResponse(
  response: unknown,
  context: string,
): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type
  const responseAny = response as any;

  if (Buffer.isBuffer(response)) {
    return response;
  }
  if (response instanceof ArrayBuffer) {
    return Buffer.from(response);
  }
  if (responseAny.data && Buffer.isBuffer(responseAny.data)) {
    return responseAny.data;
  }
  if (responseAny.data instanceof ArrayBuffer) {
    return Buffer.from(responseAny.data);
  }
  if (typeof responseAny.getReadableStream === "function") {
    const stream = responseAny.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (typeof responseAny.writeFile === "function") {
    const tmpPath = makeTempPath("feishu_dl", context);
    try {
      await responseAny.writeFile(tmpPath);
      return await fs.promises.readFile(tmpPath);
    } finally {
      await fs.promises.unlink(tmpPath).catch(() => {});
    }
  }
  if (typeof responseAny[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of responseAny) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (typeof responseAny.read === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of responseAny as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  throw new Error(`Feishu ${context}: unexpected response format`);
}

export type DownloadImageResult = {
  buffer: Buffer;
  contentType?: string;
};

export type DownloadMessageResourceResult = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};

/**
 * Download an image from Feishu using image_key.
 * Used for downloading images sent in messages.
 */
export async function downloadImageFeishu(params: {
  cfg: ClawdbotConfig;
  imageKey: string;
  accountId?: string;
}): Promise<DownloadImageResult> {
  const { cfg, imageKey, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  const response = await client.im.image.get({
    path: { image_key: imageKey },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type
  const responseAny = response as any;
  if (responseAny.code !== undefined && responseAny.code !== 0) {
    throw new Error(
      `Feishu image download failed: ${responseAny.msg || `code ${responseAny.code}`}`,
    );
  }

  const buffer = await extractBufferFromResponse(response, "image download");
  return { buffer };
}

/**
 * Download a message resource (file/image/audio/video) from Feishu.
 * Used for downloading files, audio, and video from messages.
 */
export async function downloadMessageResourceFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  fileKey: string;
  type: "image" | "file";
  accountId?: string;
}): Promise<DownloadMessageResourceResult> {
  const { cfg, messageId, fileKey, type, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  const response = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type
  const responseAny = response as any;
  if (responseAny.code !== undefined && responseAny.code !== 0) {
    throw new Error(
      `Feishu message resource download failed: ${responseAny.msg || `code ${responseAny.code}`}`,
    );
  }

  const buffer = await extractBufferFromResponse(response, "resource download");
  return { buffer };
}

export type UploadImageResult = {
  imageKey: string;
};

export type UploadFileResult = {
  fileKey: string;
};

export type SendMediaResult = {
  messageId: string;
  chatId: string;
};

/**
 * Upload an image to Feishu and get an image_key for sending.
 * Supports: JPEG, PNG, WEBP, GIF, TIFF, BMP, ICO
 */
export async function uploadImageFeishu(params: {
  cfg: ClawdbotConfig;
  image: Buffer | string; // Buffer or file path
  imageType?: "message" | "avatar";
  accountId?: string;
}): Promise<UploadImageResult> {
  const { cfg, image, imageType = "message", accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  // form-data (used by Axios for multipart) cannot determine the length of
  // a generic Readable created via Readable.from(buffer), which causes a
  // zero-length upload.  Writing to a temp file and using fs.createReadStream
  // gives form-data a .path it can fs.stat, so the upload works correctly.
  let imageStream: fs.ReadStream;
  let tmpPath: string | null = null;
  if (typeof image === "string") {
    imageStream = fs.createReadStream(image);
  } else {
    tmpPath = makeTempPath("feishu_upload", "img");
    await fs.promises.writeFile(tmpPath, image);
    imageStream = fs.createReadStream(tmpPath);
  }

  try {
    const response = await client.im.image.create({
      data: {
        image_type: imageType,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK stream type
        image: imageStream as any,
      },
    });

    // SDK v1.30+ returns data directly without code wrapper on success
    // On error, it throws or returns { code, msg }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type
    const responseAny = response as any;
    if (responseAny.code !== undefined && responseAny.code !== 0) {
      throw new Error(
        `Feishu image upload failed: ${responseAny.msg || `code ${responseAny.code}`}`,
      );
    }

    const imageKey = responseAny.image_key ?? responseAny.data?.image_key;
    if (!imageKey) {
      throw new Error("Feishu image upload failed: no image_key returned");
    }

    return { imageKey };
  } finally {
    if (tmpPath) {
      await fs.promises.unlink(tmpPath).catch(() => {});
    }
  }
}

/**
 * Upload a file to Feishu and get a file_key for sending.
 * Max file size: 30MB
 */
export async function uploadFileFeishu(params: {
  cfg: ClawdbotConfig;
  file: Buffer | string; // Buffer or file path
  fileName: string;
  fileType: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";
  duration?: number; // Required for audio/video files, in milliseconds
  accountId?: string;
}): Promise<UploadFileResult> {
  const { cfg, file, fileName, fileType, duration, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);

  // Same temp-file approach as uploadImageFeishu — see comment there.
  let fileStream: fs.ReadStream;
  let tmpPath: string | null = null;
  if (typeof file === "string") {
    fileStream = fs.createReadStream(file);
  } else {
    tmpPath = makeTempPath("feishu_upload", fileName);
    await fs.promises.writeFile(tmpPath, file);
    fileStream = fs.createReadStream(tmpPath);
  }

  try {
    const response = await client.im.file.create({
      data: {
        file_type: fileType,
        file_name: fileName,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK stream type
        file: fileStream as any,
        ...(duration !== undefined && { duration }),
      },
    });

    // SDK v1.30+ returns data directly without code wrapper on success
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type
    const responseAny = response as any;
    if (responseAny.code !== undefined && responseAny.code !== 0) {
      throw new Error(
        `Feishu file upload failed: ${responseAny.msg || `code ${responseAny.code}`}`,
      );
    }

    const fileKey = responseAny.file_key ?? responseAny.data?.file_key;
    if (!fileKey) {
      throw new Error("Feishu file upload failed: no file_key returned");
    }

    return { fileKey };
  } finally {
    if (tmpPath) {
      await fs.promises.unlink(tmpPath).catch(() => {});
    }
  }
}

/**
 * Send an image message using an image_key
 */
export async function sendImageFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  imageKey: string;
  replyToMessageId?: string;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, imageKey, replyToMessageId, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const receiveId = normalizeFeishuTarget(to);
  if (!receiveId) {
    throw new Error(`Invalid Feishu target: ${to}`);
  }

  const receiveIdType = resolveReceiveIdType(receiveId);
  const content = JSON.stringify({ image_key: imageKey });

  if (replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: {
        content,
        msg_type: "image",
      },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu image reply failed: ${response.msg || `code ${response.code}`}`);
    }

    return {
      messageId: response.data?.message_id ?? "unknown",
      chatId: receiveId,
    };
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: "image",
    },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu image send failed: ${response.msg || `code ${response.code}`}`);
  }

  return {
    messageId: response.data?.message_id ?? "unknown",
    chatId: receiveId,
  };
}

/**
 * Send a file message using a file_key
 */
export async function sendFileFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  fileKey: string;
  replyToMessageId?: string;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, fileKey, replyToMessageId, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  const client = createFeishuClient(account);
  const receiveId = normalizeFeishuTarget(to);
  if (!receiveId) {
    throw new Error(`Invalid Feishu target: ${to}`);
  }

  const receiveIdType = resolveReceiveIdType(receiveId);
  const content = JSON.stringify({ file_key: fileKey });

  if (replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: {
        content,
        msg_type: "file",
      },
    });

    if (response.code !== 0) {
      throw new Error(`Feishu file reply failed: ${response.msg || `code ${response.code}`}`);
    }

    return {
      messageId: response.data?.message_id ?? "unknown",
      chatId: receiveId,
    };
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: "file",
    },
  });

  if (response.code !== 0) {
    throw new Error(`Feishu file send failed: ${response.msg || `code ${response.code}`}`);
  }

  return {
    messageId: response.data?.message_id ?? "unknown",
    chatId: receiveId,
  };
}

/**
 * Helper to detect file type from extension
 */
export function detectFileType(
  fileName: string,
): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".opus":
    case ".ogg":
      return "opus";
    case ".mp4":
    case ".mov":
    case ".avi":
      return "mp4";
    case ".pdf":
      return "pdf";
    case ".doc":
    case ".docx":
      return "doc";
    case ".xls":
    case ".xlsx":
      return "xls";
    case ".ppt":
    case ".pptx":
      return "ppt";
    default:
      return "stream";
  }
}

/**
 * Check if a string is a local file path (not a URL)
 */
function isLocalPath(urlOrPath: string): boolean {
  // Starts with / or ~ or drive letter (Windows)
  if (urlOrPath.startsWith("/") || urlOrPath.startsWith("~") || /^[a-zA-Z]:/.test(urlOrPath)) {
    return true;
  }
  // Try to parse as URL - if it fails or has no protocol, it's likely a local path
  try {
    const url = new URL(urlOrPath);
    return url.protocol === "file:";
  } catch {
    return true; // Not a valid URL, treat as local path
  }
}

/**
 * Upload and send media (image or file) from URL, local path, or buffer
 */
export async function sendMediaFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  mediaUrl?: string;
  mediaBuffer?: Buffer;
  fileName?: string;
  replyToMessageId?: string;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, mediaUrl, mediaBuffer, fileName, replyToMessageId, accountId } = params;

  let buffer: Buffer;
  let name: string;

  if (mediaBuffer) {
    buffer = mediaBuffer;
    name = fileName ?? "file";
  } else if (mediaUrl) {
    if (isLocalPath(mediaUrl)) {
      // Local file path - read directly
      let filePath: string;
      if (mediaUrl.startsWith("~")) {
        filePath = mediaUrl.replace("~", os.homedir());
      } else if (mediaUrl.startsWith("file://")) {
        filePath = fileURLToPath(mediaUrl);
      } else {
        filePath = mediaUrl;
      }

      try {
        buffer = await fs.promises.readFile(filePath);
      } catch {
        throw new Error(`Local file not found or unreadable: ${filePath}`);
      }
      name = fileName ?? path.basename(filePath);
    } else {
      // Remote URL - fetch
      const response = await fetch(mediaUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch media from URL: ${response.status}`);
      }
      buffer = Buffer.from(await response.arrayBuffer());
      name = fileName ?? (path.basename(new URL(mediaUrl).pathname) || "file");
    }
  } else {
    throw new Error("Either mediaUrl or mediaBuffer must be provided");
  }

  // Determine if it's an image based on extension
  const ext = path.extname(name).toLowerCase();
  const isImage = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"].includes(ext);

  if (isImage) {
    const { imageKey } = await uploadImageFeishu({ cfg, image: buffer, accountId });
    return sendImageFeishu({ cfg, to, imageKey, replyToMessageId, accountId });
  } else {
    const fileType = detectFileType(name);
    const { fileKey } = await uploadFileFeishu({
      cfg,
      file: buffer,
      fileName: name,
      fileType,
      accountId,
    });
    return sendFileFeishu({ cfg, to, fileKey, replyToMessageId, accountId });
  }
}
