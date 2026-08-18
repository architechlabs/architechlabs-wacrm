import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  failureStatusText,
  MessageStatusIcon,
  type FailureStatusLabels,
} from "./message-bubble";
import type { Message } from "@/types";

const labels: FailureStatusLabels = {
  failed: "Message failed",
  metaError: "Meta error",
  notRecorded: "Detailed error information was not recorded.",
};

function failedMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "message-1",
    conversation_id: "conversation-1",
    sender_type: "agent",
    content_type: "template",
    status: "failed",
    created_at: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

describe("failed message status details", () => {
  it("renders the Meta error code and sanitized reason on the failed icon", () => {
    const message = failedMessage({
      failure_code: 131026,
      failure_reason: "Message undeliverable",
    });
    const markup = renderToStaticMarkup(
      <MessageStatusIcon message={message} failureLabels={labels} />,
    );

    expect(failureStatusText(message, labels)).toBe(
      "Message failed\nMeta error 131026\nMessage undeliverable",
    );
    expect(markup).toContain("Meta error 131026");
    expect(markup).toContain("Message undeliverable");
    expect(markup).toContain("cursor-help");
  });

  it("renders a safe fallback for historical failed rows without details", () => {
    const message = failedMessage();

    expect(failureStatusText(message, labels)).toBe(
      "Message failed\nDetailed error information was not recorded.",
    );
  });
});
