import { describe, expect, it } from "vitest";

import {
  extractFailureDetails,
  sanitizeFailureText,
} from "./status-failure";

describe("WhatsApp failed-status sanitization", () => {
  it("extracts the documented code, title, message, and details", () => {
    expect(
      extractFailureDetails([
        {
          code: 131026,
          title: "Message undeliverable",
          message: "Message undeliverable",
          error_data: { details: "The recipient could not receive it." },
        },
      ]),
    ).toEqual({
      failureCode: 131026,
      failureReason:
        "Message undeliverable - The recipient could not receive it.",
    });
  });

  it("redacts credentials, recipient identifiers, links, and raw-only fields", () => {
    const details = extractFailureDetails([
      {
        code: 130429,
        title: "Rate limit hit",
        message:
          "Authorization: Bearer secret-token-value phone +1 415 555 0123",
        error_data: {
          details:
            "access_token=super-secret-value https://example.test/private?key=secret",
        },
        raw_payload_marker: "must-not-be-retained",
      } as never,
    ]);

    const persisted = JSON.stringify(details);
    expect(persisted).toContain("130429");
    expect(persisted).toContain("[redacted]");
    expect(persisted).not.toContain("secret-token-value");
    expect(persisted).not.toContain("415 555 0123");
    expect(persisted).not.toContain("super-secret-value");
    expect(persisted).not.toContain("example.test");
    expect(persisted).not.toContain("must-not-be-retained");
  });

  it("returns no details when Meta supplies no usable errors", () => {
    expect(extractFailureDetails(undefined)).toBeNull();
    expect(extractFailureDetails([])).toBeNull();
    expect(extractFailureDetails([{}])).toBeNull();
  });

  it("bounds stored text", () => {
    expect(sanitizeFailureText("diagnostic ".repeat(80))).toHaveLength(500);
  });
});
