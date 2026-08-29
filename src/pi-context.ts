import os from "node:os";
import path from "node:path";
import { type SessionTimeline } from "./domain.ts";
import {
  EMPTY_TIMELINE,
  messagesFrom,
  openSessionFile,
  piExtractor,
  sampleJsonlSession,
} from "./sessions.ts";

const SESSION_TAIL_BYTES = 512 * 1024;

function sessionsRoot(env: NodeJS.ProcessEnv): string {
  const agentDir =
    env.PI_CODING_AGENT_DIR ||
    path.join(env.HOME || os.homedir(), ".pi", "agent");
  return path.join(agentDir, "sessions");
}

export async function recentUserMessages(
  sessionPath: string,
  limit = 6,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const session = await openSessionFile(sessionPath, sessionsRoot(env));
  if (!session) return [];
  try {
    const start = Math.max(0, session.size - SESSION_TAIL_BYTES);
    const count = Math.max(0, session.size - start);
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await session.handle.read(buffer, 0, count, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : text.slice(newline + 1);
    }
    return messagesFrom(text, piExtractor).slice(-limit);
  } finally {
    await session.handle.close();
  }
}

export async function sampledUserMessages(
  sessionPath: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionTimeline> {
  if (!sessionPath) return EMPTY_TIMELINE;
  const digest = await sampleJsonlSession(
    sessionPath,
    sessionsRoot(env),
    piExtractor,
  );
  return digest.timeline;
}
