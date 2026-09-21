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
  test("redacts MIGRATE credentials after AUTH/AUTH2 keywords", () => {
    expect(redactSensitive("MIGRATE host 6379 key 0 5000 AUTH s3cret")).toBe("MIGRATE host 6379 key 0 5000 AUTH (redacted)");
    expect(redactSensitive("MIGRATE host 6379 key 0 5000 AUTH2 user s3cret")).toBe("MIGRATE host 6379 key 0 5000 AUTH2 (redacted)");
    expect(redactSensitive("MIGRATE host 6379 key 0 5000")).toBe("MIGRATE host 6379 key 0 5000");
  });
  test("redacts CONFIG SET password parameters", () => {
    expect(redactSensitive("CONFIG SET masterauth s3cret")).toBe("CONFIG SET masterauth (redacted)");
    expect(redactSensitive("CONFIG SET requirepass s3cret")).toBe("CONFIG SET requirepass (redacted)");
    expect(redactSensitive("CONFIG SET maxmemory 100mb")).toBe("CONFIG SET maxmemory 100mb");
    expect(redactSensitive("CONFIG GET requirepass")).toBe("CONFIG GET requirepass");
  });
  test("redacts ACL SETUSER credential tokens individually", () => {
    expect(redactSensitive("ACL SETUSER alice >s3cret #hash on ~*")).toBe("ACL SETUSER alice (redacted) (redacted) on ~*");
    expect(redactSensitive("ACL GETUSER alice")).toBe("ACL GETUSER alice");
  });
  test("redacts ACL credential-removal tokens (< and !)", () => {
    expect(redactSensitive("ACL SETUSER a <s3cret")).toBe("ACL SETUSER a (redacted)");
    expect(redactSensitive("ACL SETUSER a !hash")).toBe("ACL SETUSER a (redacted)");
    expect(redactSensitive('ACL SETUSER a "<s3cret" ">other"')).toBe('ACL SETUSER a (redacted) (redacted)');
  });
  test("a quoted command name cannot smuggle credentials past redaction", () => {
    expect(redactSensitive('"AUTH" s3cret')).toBe("AUTH (redacted)");
    expect(redactSensitive("'AUTH' s3cret")).toBe("AUTH (redacted)");
  });
  test("strips credentials from pasted connection URLs anywhere on a line", () => {
    expect(redactSensitive('SET note "redis://default:s3cret@h:6379/0"')).toBe('SET note "redis://(redacted)@h:6379/0"');
    expect(redactSensitive("rediss://u:p@h:6380")).toBe("rediss://(redacted)@h:6380");
    expect(redactSensitive("redis://h:6379")).toBe("redis://h:6379");
    // An '@' inside the password must not leave a fragment behind.
    expect(redactSensitive("redis://u:p@ss@h")).toBe("redis://(redacted)@h");
  });
  test("redacts SENTINEL and TLS credential parameters", () => {
    expect(redactSensitive("SENTINEL SET mymaster auth-pass s3cret")).toBe("SENTINEL SET mymaster auth-pass (redacted)");
    expect(redactSensitive("SENTINEL SET mymaster auth-user deploy")).toBe("SENTINEL SET mymaster auth-user (redacted)");
    expect(redactSensitive("SENTINEL MONITOR m h 6379 2")).toBe("SENTINEL MONITOR m h 6379 2");
    expect(redactSensitive("CONFIG SET tls-key-file-pass s3cret")).toBe("CONFIG SET tls-key-file-pass (redacted)");
    expect(redactSensitive("CONFIG SET tls-client-key-file-pass s3cret")).toBe("CONFIG SET tls-client-key-file-pass (redacted)");
    expect(redactSensitive("CONFIG SET sentinel-auth-pass s3cret")).toBe("CONFIG SET sentinel-auth-pass (redacted)");
    expect(redactSensitive("CONFIG SET sentinel-auth-user deploy")).toBe("CONFIG SET sentinel-auth-user (redacted)");
  });
  test("leaves ordinary commands untouched", () => {
    expect(redactSensitive("GET mykey")).toBe("GET mykey");
    expect(redactSensitive("SET k hello world")).toBe("SET k hello world");
  });
  test("processes multi-line input line by line", () => {
    expect(redactSensitive("PING\nAUTH s3cret\nGET k")).toBe("PING\nAUTH (redacted)\nGET k");
  });
});
