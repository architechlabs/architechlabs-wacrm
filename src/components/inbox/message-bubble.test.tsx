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
  metaCode: "Meta code",
  notRecorded: "Detailed error information was not recorded.",
  restrictionTitle: "Message not delivered",
  restrictionExplanation:
    "Meta restricted this marketing message for this recipient.",
  doNotRetryImmediately: "Do not retry immediately.",
  recommended: "Recommended:",
  waitBeforeRetry: "Wait before trying this marketing template again, or",
  askCustomerFirst: "Ask the customer to message the business first.",
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

  it("shows the friendly 131049 guidance and suppresses the raw reason", () => {
    const message = failedMessage({
      failure_code: 131049,
      failure_reason:
        "This message was not delivered to maintain healthy ecosystem engagement.",
    });
    const text = failureStatusText(message, labels);
    const markup = renderToStaticMarkup(
      <MessageStatusIcon message={message} failureLabels={labels} />,
    );

    expect(text).toContain("Message not delivered");
    expect(text).toContain("Do not retry immediately.");
    expect(text).toContain("Meta code 131049");
    expect(text).not.toContain("healthy ecosystem engagement");
    expect(markup).toContain("Meta code 131049");
  });

  it("keeps unrelated Meta failure reasons visible", () => {
    const message = failedMessage({
      failure_code: 131026,
      failure_reason: "Message undeliverable",
    });

    expect(failureStatusText(message, labels)).toContain(
      "Message undeliverable",
    );
  });
});
