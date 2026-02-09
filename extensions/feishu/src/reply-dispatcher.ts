import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type ClawdbotConfig,
  type RuntimeEnv,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import type { MentionTarget } from "./mention.js";
import { resolveFeishuAccount } from "./accounts.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu, sendMarkdownCardFeishu } from "./send.js";
import { sendMediaFeishu } from "./media.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

/**
 * Lightweight fallback MEDIA: token extractor.
 * Used when the upstream pipeline doesn't set mediaUrls on the payload
 * (e.g., during block streaming where final payloads may be dropped).
 */
const MEDIA_TOKEN_RE = /\bMEDIA:\s*`?([^\n]+)`?/gi;

function extractMediaFromText(text: string): { cleanedText: string; mediaUrls: string[] } {
  const mediaUrls: string[] = [];
  const lines = text.split("\n");
  const keptLines: string[] = [];

  for (const line of lines) {
    const trimmedStart = line.trimStart();
    if (!trimmedStart.startsWith("MEDIA:")) {
      keptLines.push(line);
      continue;
    }

    const matches = Array.from(line.matchAll(MEDIA_TOKEN_RE));
    if (matches.length === 0) {
      keptLines.push(line);
      continue;
    }

    let foundValid = false;
    for (const match of matches) {
      const raw = match[1].replace(/^[`"'[{(]+/, "").replace(/[`"'\\})\],]+$/, "").trim();
      if (!raw || raw.length > 4096) continue;
      // Accept: http(s) URLs, relative paths, absolute unix/windows paths
      if (
        /^https?:\/\//i.test(raw) ||
        raw.startsWith("./") ||
        raw.startsWith("/") ||
        /^[a-zA-Z]:[/\\]/.test(raw)
      ) {
        if (!raw.includes("..")) {
          mediaUrls.push(raw);
          foundValid = true;
        }
      }
    }

    if (!foundValid) {
      keptLines.push(line);
    }
  }

  const cleanedText = keptLines.join("\n").replace(/\n{2,}/g, "\n").trim();
  return { cleanedText, mediaUrls };
}

/**
 * Detect if text contains markdown elements that benefit from card rendering.
 * Used by auto render mode.
 */
function shouldUseCard(text: string): boolean {
  // Code blocks (fenced)
  if (/```[\s\S]*?```/.test(text)) {
    return true;
  }
  // Tables (at least header + separator row with |)
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) {
    return true;
  }
  return false;
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  /** Mention targets, will be auto-included in replies */
  mentionTargets?: MentionTarget[];
  /** Account ID for multi-account support */
  accountId?: string;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const { cfg, agentId, chatId, replyToMessageId, mentionTargets, accountId } = params;

  // Resolve account for config access
  const account = resolveFeishuAccount({ cfg, accountId });

  const prefixContext = createReplyPrefixContext({
    cfg,
    agentId,
  });

  // Feishu doesn't have a native typing indicator API.
  // We use message reactions as a typing indicator substitute.
  let typingState: TypingIndicatorState | null = null;

  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      if (!replyToMessageId) {
        return;
      }
      typingState = await addTypingIndicator({ cfg, messageId: replyToMessageId, accountId });
      params.runtime.log?.(`feishu[${account.accountId}]: added typing indicator reaction`);
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({ cfg, state: typingState, accountId });
      typingState = null;
      params.runtime.log?.(`feishu[${account.accountId}]: removed typing indicator reaction`);
    },
    onStartError: (err) => {
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "start",
        error: err,
      });
    },
    onStopError: (err) => {
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "stop",
        error: err,
      });
    },
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit({
    cfg,
    channel: "feishu",
    defaultLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
  });

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: typingCallbacks.onReplyStart,
      deliver: async (payload: ReplyPayload) => {
        params.runtime.log?.(
          `feishu[${account.accountId}] deliver called: text=${payload.text?.slice(0, 100)}, mediaUrls=${JSON.stringify(payload.mediaUrls)}, mediaUrl=${payload.mediaUrl}`,
        );
        let text = payload.text ?? "";
        // Use pre-parsed mediaUrls from upstream, or fall back to inline extraction
        let mediaUrls: string[] =
          payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);

        // Fallback: if text contains MEDIA: tokens but mediaUrls is empty,
        // parse them out (handles block streaming where final payloads may be dropped)
        if (mediaUrls.length === 0 && text.includes("MEDIA:")) {
          const extracted = extractMediaFromText(text);
          if (extracted.mediaUrls.length > 0) {
            mediaUrls = extracted.mediaUrls;
            text = extracted.cleanedText;
            params.runtime.log?.(
              `feishu[${account.accountId}] deliver: extracted ${mediaUrls.length} media from text fallback`,
            );
          }
        }

        // Send media attachments if present
        if (mediaUrls.length > 0) {
          params.runtime.log?.(
            `feishu[${account.accountId}] deliver: sending ${mediaUrls.length} media to ${chatId}`,
          );
          // Send text first (if any)
          if (text.trim()) {
            await sendMessageFeishu({ cfg, to: chatId, text, replyToMessageId, accountId });
          }
          for (const url of mediaUrls) {
            try {
              await sendMediaFeishu({ cfg, to: chatId, mediaUrl: url, accountId });
            } catch (err) {
              params.runtime.error?.(
                `feishu[${account.accountId}] media send failed: ${String(err)}`,
              );
              await sendMessageFeishu({
                cfg,
                to: chatId,
                text: `[media error] ${url}`,
                accountId,
              });
            }
          }
          return;
        }

        if (!text.trim()) {
          params.runtime.log?.(`feishu[${account.accountId}] deliver: empty text, skipping`);
          return;
        }

        // Check render mode: auto (default), raw, or card
        const feishuCfg = account.config;
        const renderMode = feishuCfg?.renderMode ?? "auto";

        // Determine if we should use card for this message
        const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));

        // Only include @mentions in the first chunk (avoid duplicate @s)
        let isFirstChunk = true;

        if (useCard) {
          // Card mode: send as interactive card with markdown rendering
          const chunks = core.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode);
          params.runtime.log?.(
            `feishu[${account.accountId}] deliver: sending ${chunks.length} card chunks to ${chatId}`,
          );
          for (const chunk of chunks) {
            await sendMarkdownCardFeishu({
              cfg,
              to: chatId,
              text: chunk,
              replyToMessageId,
              mentions: isFirstChunk ? mentionTargets : undefined,
              accountId,
            });
            isFirstChunk = false;
          }
        } else {
          // Raw mode: send as plain text with table conversion
          const converted = core.channel.text.convertMarkdownTables(text, tableMode);
          const chunks = core.channel.text.chunkTextWithMode(converted, textChunkLimit, chunkMode);
          params.runtime.log?.(
            `feishu[${account.accountId}] deliver: sending ${chunks.length} text chunks to ${chatId}`,
          );
          for (const chunk of chunks) {
            await sendMessageFeishu({
              cfg,
              to: chatId,
              text: chunk,
              replyToMessageId,
              mentions: isFirstChunk ? mentionTargets : undefined,
              accountId,
            });
            isFirstChunk = false;
          }
        }
      },
      onError: (err, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(err)}`,
        );
        typingCallbacks.onIdle?.();
      },
      onIdle: typingCallbacks.onIdle,
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
    },
    markDispatchIdle,
  };
}
