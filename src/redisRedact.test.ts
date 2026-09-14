import { describe, test, expect } from "bun:test";
import { redactSensitive } from "./redisRedact.ts";

describe("redactSensitive", () => {
  test("redacts everything after AUTH — no argument prefix survives", () => {
    expect(redactSensitive("AUTH s3cret")).toBe("AUTH (redacted)");
    expect(redactSensitive("AUTH default s3cret")).toBe("AUTH (redacted)");
    expect(redactSensitive('AUTH "top secret"')).toBe("AUTH (redacted)");
    expect(redactSensitive("AUTH sec")).toBe("AUTH (redacted)");
    expect(redactSensitive("AUTH")).toBe("AUTH");
  });
  test("redacts HELLO AUTH arguments wholesale", () => {
    expect(redactSensitive("HELLO 3 AUTH default s3cret")).toBe("HELLO 3 AUTH (redacted)");
    expect(redactSensitive('HELLO 3 AUTH "user name" "pass word"')).toBe("HELLO 3 AUTH (redacted)");
    expect(redactSensitive("HELLO 3 SETNAME client1")).toBe("HELLO 3 SETNAME client1");
  });
  test("leaves ordinary commands untouched", () => {
    expect(redactSensitive("GET mykey")).toBe("GET mykey");
    expect(redactSensitive("SET k hello world")).toBe("SET k hello world");
  });
  test("processes multi-line input line by line", () => {
    expect(redactSensitive("PING\nAUTH s3cret\nGET k")).toBe("PING\nAUTH (redacted)\nGET k");
  });
});
