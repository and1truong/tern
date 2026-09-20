// Built-in Redis/Valkey command catalog. Pure data + lookup, shared by the
// server (write classification, catalog enrichment) and the client bundle
// (autocomplete, explain, lint). Runtime COMMAND DOCS metadata may refine
// summaries/complexity, but the safety model here is authoritative.
export type CommandGroup =
  | "key" | "string" | "hash" | "list" | "set" | "sorted-set" | "stream"
  | "connection" | "server" | "scripting" | "pubsub" | "transactions" | "cluster";

export interface CommandArgSpec {
  name: string;
  type?: "key" | "string" | "int" | "double" | "pattern" | "enum" | "unix-time";
  description?: string;
  enum?: string[];        // for type "enum": literal tokens
  optional?: boolean;
  multiple?: boolean;     // repeats; a trailing key spec with multiple covers variadic key lists
  /** alternates with the previous multiple spec, e.g. HSET field,value pairs */
  interleaved?: boolean;
}

export interface CommandDoc {
  name: string;               // canonical uppercase
  group: CommandGroup;
  arity: number;              // Redis arity: positive exact, negative means minimum (-x ⇒ at least x incl. command name)
  summary: string;
  since: string;
  access: "read" | "write" | "read-write" | "admin";
  complexity?: string;
  args?: CommandArgSpec[];
  returns?: string;           // expected result, human phrasing
  blocking?: boolean;
  ttl?: "clear" | "set" | "none";
  danger?: "destructive" | "full-scan" | "admin" | "config";
  notes?: string;             // cluster/large-key guidance shown by explain
}

export const commandCatalog: CommandDoc[] = [
  // --- keyspace ---
  { name: "DEL", group: "key", arity: -3, summary: "Remove one or more keys", since: "1.0.0", access: "write", complexity: "O(N)", args: [{ name: "key", type: "key", multiple: true }], returns: "Number of keys removed.", ttl: "none", notes: "Blocking on very large keys; UNLINK frees memory asynchronously." },
  { name: "UNLINK", group: "key", arity: -3, summary: "Remove one or more keys asynchronously, freeing memory in the background", since: "4.0.0", access: "write", complexity: "O(1) per key, reclaim async", args: [{ name: "key", type: "key", multiple: true }], returns: "Number of keys removed.", ttl: "none" },
  { name: "EXISTS", group: "key", arity: -2, summary: "Count how many of the given keys exist", since: "1.0.0", access: "read", complexity: "O(N)", args: [{ name: "key", type: "key", multiple: true }], returns: "Number of keys that exist (duplicates counted)." },
  { name: "EXPIRE", group: "key", arity: -3, summary: "Set a key's time to live in seconds", since: "1.0.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "seconds", type: "int" }, { name: "condition", type: "enum", enum: ["NX", "XX", "GT", "LT"], optional: true }], returns: "1 when the TTL was set, 0 when the key does not exist or the condition failed.", ttl: "set" },
  { name: "PEXPIRE", group: "key", arity: -3, summary: "Set a key's time to live in milliseconds", since: "2.6.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "milliseconds", type: "int" }, { name: "condition", type: "enum", enum: ["NX", "XX", "GT", "LT"], optional: true }], returns: "1 when the TTL was set, 0 otherwise.", ttl: "set" },
  { name: "EXPIREAT", group: "key", arity: -3, summary: "Set a key's expiration to a Unix timestamp in seconds", since: "1.2.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "timestamp", type: "unix-time" }, { name: "condition", type: "enum", enum: ["NX", "XX", "GT", "LT"], optional: true }], returns: "1 when the TTL was set, 0 otherwise.", ttl: "set" },
  { name: "PEXPIREAT", group: "key", arity: -3, summary: "Set a key's expiration to a Unix timestamp in milliseconds", since: "2.6.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "timestamp", type: "unix-time" }, { name: "condition", type: "enum", enum: ["NX", "XX", "GT", "LT"], optional: true }], returns: "1 when the TTL was set, 0 otherwise.", ttl: "set" },
  { name: "TTL", group: "key", arity: 2, summary: "Get a key's remaining time to live in seconds", since: "1.0.0", access: "read", complexity: "O(1)", args: [{ name: "key", type: "key" }], returns: "-2 missing key · -1 no expiry · otherwise seconds remaining." },
  { name: "PTTL", group: "key", arity: 2, summary: "Get a key's remaining time to live in milliseconds", since: "2.6.0", access: "read", complexity: "O(1)", args: [{ name: "key", type: "key" }], returns: "-2 missing key · -1 no expiry · otherwise milliseconds remaining." },
  { name: "PERSIST", group: "key", arity: 2, summary: "Remove the expiration from a key", since: "2.2.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }], returns: "1 when the TTL was removed, 0 when absent or no TTL.", ttl: "clear" },
  { name: "TYPE", group: "key", arity: 2, summary: "Determine the type stored at a key", since: "1.0.0", access: "read", complexity: "O(1)", args: [{ name: "key", type: "key" }], returns: "string · list · set · zset · hash · stream · none." },
  { name: "RENAME", group: "key", arity: 3, summary: "Rename a key, overwriting the destination if it exists", since: "1.0.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "newkey", type: "key" }], returns: '"OK", or an error when the source key is missing.', ttl: "none", notes: "The TTL travels with the key; an existing destination is silently replaced." },
  { name: "RENAMENX", group: "key", arity: 3, summary: "Rename a key only when the destination does not exist", since: "1.0.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "newkey", type: "key" }], returns: "1 renamed · 0 destination already existed · error when missing.", ttl: "none" },
  { name: "SCAN", group: "key", arity: -2, summary: "Incrementally iterate the keyspace", since: "2.8.0", access: "read", complexity: "O(1) per call", args: [{ name: "cursor", type: "int", description: '"0" starts a new iteration; use the returned cursor to continue' }, { name: "MATCH", type: "enum", enum: ["MATCH"], optional: true }, { name: "pattern", type: "pattern", optional: true }, { name: "COUNT", type: "enum", enum: ["COUNT"], optional: true }, { name: "count", type: "int", optional: true, description: "Approximate elements examined per call" }, { name: "TYPE", type: "enum", enum: ["TYPE"], optional: true, description: "Requires Redis 6+; filter by a single type" }, { name: "type", type: "string", optional: true }], returns: "[next-cursor, [keys…]] — iteration is complete when the cursor returns to 0." },
  { name: "RANDOMKEY", group: "key", arity: 1, summary: "Return a random key from the selected database", since: "1.0.0", access: "read", complexity: "O(1)", returns: "A key name, or nil when the database is empty." },
  { name: "DBSIZE", group: "key", arity: 1, summary: "Count keys in the selected database", since: "1.0.0", access: "read", complexity: "O(1)", returns: "Number of keys." },
  { name: "KEYS", group: "key", arity: 2, summary: "Find all keys matching the given pattern", since: "1.0.0", access: "read", complexity: "O(N)", danger: "full-scan", args: [{ name: "pattern", type: "pattern" }], notes: "Blocks the server while scanning the whole keyspace. Use SCAN for incremental iteration." },
  { name: "FLUSHDB", group: "key", arity: -1, summary: "Remove all keys from the selected database", since: "1.0.0", access: "admin", complexity: "O(N)", danger: "destructive", args: [{ name: "mode", type: "enum", enum: ["ASYNC", "SYNC"], optional: true }], returns: '"OK".' },
  { name: "FLUSHALL", group: "server", arity: -1, summary: "Remove all keys from all databases", since: "1.0.0", access: "admin", complexity: "O(N)", danger: "destructive", args: [{ name: "mode", type: "enum", enum: ["ASYNC", "SYNC"], optional: true }], returns: '"OK".' },
  { name: "TOUCH", group: "key", arity: -2, summary: "Update the last-access time of keys without reading them", since: "3.2.0", access: "write", complexity: "O(N)", args: [{ name: "key", type: "key", multiple: true }], returns: "Number of keys touched." },
  { name: "COPY", group: "key", arity: -3, summary: "Copy a key's value to another key", since: "6.2.0", access: "write", complexity: "O(N)", args: [{ name: "source", type: "key" }, { name: "destination", type: "key" }, { name: "DB", type: "enum", enum: ["DB"], optional: true }, { name: "db", type: "int", optional: true }, { name: "REPLACE", type: "enum", enum: ["REPLACE"], optional: true }], returns: "1 copied · 0 when the source is missing or destination exists without REPLACE." },
  { name: "MOVE", group: "key", arity: 3, summary: "Move a key to another database index", since: "1.0.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "db", type: "int" }], returns: "1 moved · 0 when the key or target db already holds it." },
  { name: "OBJECT", group: "key", arity: -2, summary: "Inspect the internal encoding or statistics of a key", since: "2.2.0", access: "read", args: [{ name: "subcommand", type: "enum", enum: ["ENCODING", "FREQ", "IDLETIME", "REFCOUNT"] }, { name: "key", type: "key" }] },
  { name: "MEMORY", group: "server", arity: -2, summary: "Inspect or manage server memory, e.g. MEMORY USAGE key", since: "4.0.0", access: "admin", danger: "admin", args: [{ name: "subcommand", type: "enum", enum: ["USAGE", "DOCTOR", "STATS", "PURGE"] }, { name: "key", type: "key", optional: true }, { name: "SAMPLES", type: "enum", enum: ["SAMPLES"], optional: true }, { name: "samples", type: "int", optional: true }] },

  // --- strings ---
  { name: "GET", group: "string", arity: 2, summary: "Get the value of a key", since: "1.0.0", access: "read", complexity: "O(1)", args: [{ name: "key", type: "key" }], returns: "The value string, or nil when the key does not exist (error on a non-string key)." },
  { name: "SET", group: "string", arity: -3, summary: "Set the string value of a key, optionally with expiry or conditions", since: "1.0.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "value", type: "string" }, { name: "expiration", type: "enum", enum: ["EX", "PX", "EXAT", "PXAT"], optional: true, description: "Expiry flag followed by a number (seconds, milliseconds, or unix timestamps)" }, { name: "seconds", type: "int", optional: true }, { name: "condition", type: "enum", enum: ["NX", "XX", "GET", "KEEPTTL"], optional: true, description: "NX: only if absent · XX: only if present · GET: return old value · KEEPTTL: retain TTL" }], returns: '"OK" on success, nil when NX/XX prevented the write, or the old value with GET.', ttl: "clear", notes: "SET clears the TTL unless KEEPTTL is given." },
  { name: "SETNX", group: "string", arity: 3, summary: "Set the value of a key only when it does not exist", since: "1.0.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "value", type: "string" }], returns: "1 set · 0 key existed.", ttl: "none" },
  { name: "SETEX", group: "string", arity: 4, summary: "Set a key's value with an expiry in seconds", since: "2.0.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "seconds", type: "int" }, { name: "value", type: "string" }], returns: '"OK".', ttl: "set" },
  { name: "PSETEX", group: "string", arity: 4, summary: "Set a key's value with an expiry in milliseconds", since: "2.6.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "milliseconds", type: "int" }, { name: "value", type: "string" }], returns: '"OK".', ttl: "set" },
  { name: "MSET", group: "string", arity: -3, summary: "Set multiple keys to multiple values atomically", since: "1.0.1", access: "write", complexity: "O(N)", args: [{ name: "key", type: "key", multiple: true }, { name: "value", type: "string", interleaved: true }], returns: '"OK". Always applies all values (no conditions).', ttl: "clear", notes: "In cluster mode the keys must share a hash slot." },
  { name: "MSETNX", group: "string", arity: -3, summary: "Set multiple keys only when none of them exist", since: "1.0.1", access: "write", complexity: "O(N)", args: [{ name: "key", type: "key", multiple: true }, { name: "value", type: "string", interleaved: true }], returns: "1 all set · 0 none set.", ttl: "clear" },
  { name: "MGET", group: "string", arity: -2, summary: "Get the values of multiple keys", since: "1.0.0", access: "read", complexity: "O(N)", args: [{ name: "key", type: "key", multiple: true }], returns: "Array of values, nil for missing or non-string keys." },
  { name: "INCR", group: "string", arity: 2, summary: "Increment the integer value of a key by one", since: "1.0.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }], returns: "The value after the increment; error when the value is not an integer." },
  { name: "INCRBY", group: "string", arity: 3, summary: "Increment the integer value of a key by an amount", since: "1.0.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "increment", type: "int" }], returns: "The value after the increment." },
  { name: "INCRBYFLOAT", group: "string", arity: 3, summary: "Increment the float value of a key by an amount", since: "2.6.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "increment", type: "double" }], returns: "The new value as a string." },
  { name: "DECR", group: "string", arity: 2, summary: "Decrement the integer value of a key by one", since: "1.0.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }], returns: "The value after the decrement." },
  { name: "DECRBY", group: "string", arity: 3, summary: "Decrement the integer value of a key by an amount", since: "1.0.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "decrement", type: "int" }], returns: "The value after the decrement." },
  { name: "APPEND", group: "string", arity: 3, summary: "Append a value to the end of a key's string", since: "2.0.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "value", type: "string" }], returns: "The string length after the append." },
  { name: "STRLEN", group: "string", arity: 2, summary: "Get the byte length of a key's string value", since: "2.2.0", access: "read", complexity: "O(1)", args: [{ name: "key", type: "key" }], returns: "Length in bytes, 0 when missing." },
  { name: "GETRANGE", group: "string", arity: 4, summary: "Get a substring of a key's string value", since: "2.4.0", access: "read", complexity: "O(N)", args: [{ name: "key", type: "key" }, { name: "start", type: "int" }, { name: "end", type: "int" }], returns: "The substring; negative indexes count from the end." },
  { name: "SETRANGE", group: "string", arity: 4, summary: "Overwrite part of a string starting at an offset", since: "2.2.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "offset", type: "int" }, { name: "value", type: "string" }], returns: "The string length after the write; zero-padding fills gaps." },
  { name: "GETDEL", group: "string", arity: 2, summary: "Get a key's value and delete the key", since: "6.2.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }], returns: "The value, or nil when missing." },
  { name: "GETEX", group: "string", arity: -2, summary: "Get a key's value, optionally updating or removing its TTL", since: "6.2.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "expiration", type: "enum", enum: ["EX", "PX", "EXAT", "PXAT", "PERSIST"], optional: true }, { name: "amount", type: "int", optional: true }], returns: "The value string, or nil when missing.", ttl: "set" },
  { name: "GETSET", group: "string", arity: 3, summary: "Set a key's value and return the previous value", since: "1.0.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "value", type: "string" }], returns: "The old value, or nil when the key was missing.", ttl: "clear" },

  // --- hashes ---
  { name: "HSET", group: "hash", arity: -4, summary: "Set hash field(s) to value(s), creating the hash if needed", since: "4.0.0", access: "write", complexity: "O(1) per field", args: [{ name: "key", type: "key" }, { name: "field", type: "string", multiple: true, description: "field/value pairs repeat" }, { name: "value", type: "string", interleaved: true }], returns: "Number of fields that were added (new fields only)." },
  { name: "HGET", group: "hash", arity: 3, summary: "Get one hash field's value", since: "2.0.0", access: "read", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "field", type: "string" }], returns: "The value, or nil when the field is missing." },
  { name: "HGETALL", group: "hash", arity: 2, summary: "Get every field and value of a hash", since: "2.0.0", access: "read", complexity: "O(N)", args: [{ name: "key", type: "key" }], returns: "Flat [field, value, …] array.", notes: "Reads the entire hash; large hashes can produce huge replies. Page with HSCAN instead." },
  { name: "HMGET", group: "hash", arity: -2, summary: "Get the values of specific hash fields", since: "2.0.0", access: "read", complexity: "O(N)", args: [{ name: "key", type: "key" }, { name: "field", type: "string", multiple: true }], returns: "Array of values, nil for missing fields." },
  { name: "HDEL", group: "hash", arity: -3, summary: "Delete one or more hash fields", since: "2.0.0", access: "write", complexity: "O(N)", args: [{ name: "key", type: "key" }, { name: "field", type: "string", multiple: true }], returns: "Number of fields removed." },
  { name: "HLEN", group: "hash", arity: 2, summary: "Count the fields in a hash", since: "2.0.0", access: "read", complexity: "O(1)", args: [{ name: "key", type: "key" }], returns: "Field count, 0 when missing." },
  { name: "HKEYS", group: "hash", arity: 2, summary: "Get every field name in a hash", since: "2.0.0", access: "read", complexity: "O(N)", args: [{ name: "key", type: "key" }], returns: "Array of field names.", notes: "Reads the entire hash; prefer HSCAN for large hashes." },
  { name: "HVALS", group: "hash", arity: 2, summary: "Get every value in a hash", since: "2.0.0", access: "read", complexity: "O(N)", args: [{ name: "key", type: "key" }], returns: "Array of values.", notes: "Reads the entire hash; prefer HSCAN for large hashes." },
  { name: "HEXISTS", group: "hash", arity: 3, summary: "Check whether a hash field exists", since: "2.0.0", access: "read", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "field", type: "string" }], returns: "1 exists · 0 missing." },
  { name: "HINCRBY", group: "hash", arity: 4, summary: "Increment a hash field's integer value", since: "2.0.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "field", type: "string" }, { name: "increment", type: "int" }], returns: "The field's value after the increment." },
  { name: "HINCRBYFLOAT", group: "hash", arity: 4, summary: "Increment a hash field's float value", since: "2.6.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "field", type: "string" }, { name: "increment", type: "double" }], returns: "The new value as a string." },
  { name: "HSETNX", group: "hash", arity: 4, summary: "Set a hash field only when it does not exist", since: "2.0.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "field", type: "string" }, { name: "value", type: "string" }], returns: "1 set · 0 field existed." },
  { name: "HSTRLEN", group: "hash", arity: 3, summary: "Get the byte length of a hash field's value", since: "3.2.0", access: "read", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "field", type: "string" }], returns: "Length in bytes, 0 when missing." },
  { name: "HSCAN", group: "hash", arity: -3, summary: "Incrementally iterate hash fields and values", since: "2.8.0", access: "read", complexity: "O(1) per call", args: [{ name: "key", type: "key" }, { name: "cursor", type: "int" }, { name: "MATCH", type: "enum", enum: ["MATCH"], optional: true }, { name: "pattern", type: "pattern", optional: true }, { name: "COUNT", type: "enum", enum: ["COUNT"], optional: true }, { name: "count", type: "int", optional: true }, { name: "NOVALUES", type: "enum", enum: ["NOVALUES"], optional: true }], returns: "[next-cursor, [field, value, …]]." },

  // --- lists ---
  { name: "LPUSH", group: "list", arity: -3, summary: "Prepend one or more values to a list", since: "1.0.0", access: "write", complexity: "O(1) per value", args: [{ name: "key", type: "key" }, { name: "value", type: "string", multiple: true }], returns: "The list length after the push." },
  { name: "RPUSH", group: "list", arity: -3, summary: "Append one or more values to a list", since: "1.0.0", access: "write", complexity: "O(1) per value", args: [{ name: "key", type: "key" }, { name: "value", type: "string", multiple: true }], returns: "The list length after the push." },
  { name: "LPUSHX", group: "list", arity: -3, summary: "Prepend values only when the list already exists", since: "2.2.0", access: "write", complexity: "O(1) per value", args: [{ name: "key", type: "key" }, { name: "value", type: "string", multiple: true }], returns: "The list length, 0 when the list is missing." },
  { name: "RPUSHX", group: "list", arity: -3, summary: "Append values only when the list already exists", since: "2.2.0", access: "write", complexity: "O(1) per value", args: [{ name: "key", type: "key" }, { name: "value", type: "string", multiple: true }], returns: "The list length, 0 when the list is missing." },
  { name: "LPOP", group: "list", arity: -2, summary: "Remove and return the first element(s) of a list", since: "1.0.0", access: "write", complexity: "O(N)", args: [{ name: "key", type: "key" }, { name: "count", type: "int", optional: true }], returns: "The element (or array with count), nil when empty." },
  { name: "RPOP", group: "list", arity: -2, summary: "Remove and return the last element(s) of a list", since: "1.0.0", access: "write", complexity: "O(N)", args: [{ name: "key", type: "key" }, { name: "count", type: "int", optional: true }], returns: "The element (or array with count), nil when empty." },
  { name: "LLEN", group: "list", arity: 2, summary: "Get the length of a list", since: "1.0.0", access: "read", complexity: "O(1)", args: [{ name: "key", type: "key" }], returns: "Element count, 0 when missing." },
  { name: "LRANGE", group: "list", arity: 4, summary: "Get a range of list elements", since: "1.0.0", access: "read", complexity: "O(S+N)", args: [{ name: "key", type: "key" }, { name: "start", type: "int" }, { name: "stop", type: "int" }], returns: "Array of elements; negative indexes count from the end.", notes: "0 through -1 reads the entire list — bound the range for large lists." },
  { name: "LINDEX", group: "list", arity: 3, summary: "Get a list element by index", since: "1.0.0", access: "read", complexity: "O(N)", args: [{ name: "key", type: "key" }, { name: "index", type: "int" }], returns: "The element, or nil when out of range." },
  { name: "LSET", group: "list", arity: 4, summary: "Set a list element at an index", since: "1.0.0", access: "write", complexity: "O(N)", args: [{ name: "key", type: "key" }, { name: "index", type: "int" }, { name: "value", type: "string" }], returns: '"OK", or an error when the index is out of range.' },
  { name: "LREM", group: "list", arity: 4, summary: "Remove occurrences of an element from a list", since: "1.0.0", access: "write", complexity: "O(N)", args: [{ name: "key", type: "key" }, { name: "count", type: "int", description: ">0 from head · <0 from tail · 0 removes all" }, { name: "value", type: "string" }], returns: "Number of elements removed." },
  { name: "LTRIM", group: "list", arity: 4, summary: "Keep only a range of list elements", since: "1.0.0", access: "write", complexity: "O(N)", args: [{ name: "key", type: "key" }, { name: "start", type: "int" }, { name: "stop", type: "int" }], returns: '"OK". Commonly pairs with LPUSH to cap list size.' },
  { name: "LINSERT", group: "list", arity: 5, summary: "Insert an element before or after a pivot element", since: "2.2.0", access: "write", complexity: "O(N)", args: [{ name: "key", type: "key" }, { name: "position", type: "enum", enum: ["BEFORE", "AFTER"] }, { name: "pivot", type: "string" }, { name: "value", type: "string" }], returns: "The list length after insertion, -1 when the pivot is missing." },
  { name: "LMOVE", group: "list", arity: 5, summary: "Atomically move an element between lists", since: "6.2.0", access: "write", complexity: "O(1)", args: [{ name: "source", type: "key" }, { name: "destination", type: "key" }, { name: "from", type: "enum", enum: ["LEFT", "RIGHT"] }, { name: "to", type: "enum", enum: ["LEFT", "RIGHT"] }], returns: "The moved element, nil when the source is empty." },
  { name: "RPOPLPUSH", group: "list", arity: 3, summary: "Move the last element of a list onto another list (deprecated alias of LMOVE)", since: "1.0.0", access: "write", complexity: "O(1)", args: [{ name: "source", type: "key" }, { name: "destination", type: "key" }], returns: "The moved element, nil when the source is empty." },
  { name: "BLPOP", group: "list", arity: -3, summary: "Remove and return the first element of the first non-empty list, blocking if needed", since: "2.0.0", access: "write", complexity: "O(1)", blocking: true, args: [{ name: "key", type: "key", multiple: true }, { name: "timeout", type: "int", description: "Seconds; 0 blocks indefinitely" }], returns: "[key, element] or nil after the timeout expires.", notes: "Holds the client connection; timeout 0 blocks forever." },
  { name: "BRPOP", group: "list", arity: -3, summary: "Remove and return the last element of the first non-empty list, blocking if needed", since: "2.0.0", access: "write", complexity: "O(1)", blocking: true, args: [{ name: "key", type: "key", multiple: true }, { name: "timeout", type: "int", description: "Seconds; 0 blocks indefinitely" }], returns: "[key, element] or nil after the timeout expires.", notes: "Holds the client connection; timeout 0 blocks forever." },
  { name: "BLMOVE", group: "list", arity: -5, summary: "Atomically move an element between lists, blocking if needed", since: "6.2.0", access: "write", complexity: "O(1)", blocking: true, args: [{ name: "source", type: "key" }, { name: "destination", type: "key" }, { name: "from", type: "enum", enum: ["LEFT", "RIGHT"] }, { name: "to", type: "enum", enum: ["LEFT", "RIGHT"] }, { name: "timeout", type: "int" }], returns: "The moved element, nil after the timeout.", notes: "Holds the client connection; timeout 0 blocks forever." },
  { name: "BRPOPLPUSH", group: "list", arity: -4, summary: "Move the last element onto another list, blocking if needed (deprecated alias of BLMOVE)", since: "2.2.0", access: "write", complexity: "O(1)", blocking: true, args: [{ name: "source", type: "key" }, { name: "destination", type: "key" }, { name: "timeout", type: "int" }], returns: "The moved element, nil after the timeout.", notes: "Holds the client connection; timeout 0 blocks forever." },
  { name: "LPOS", group: "list", arity: -3, summary: "Find the index of an element in a list", since: "6.2.0", access: "read", complexity: "O(N)", args: [{ name: "key", type: "key" }, { name: "element", type: "string" }, { name: "RANK", type: "enum", enum: ["RANK"], optional: true }, { name: "rank", type: "int", optional: true }, { name: "COUNT", type: "enum", enum: ["COUNT"], optional: true }, { name: "count", type: "int", optional: true }, { name: "MAXLEN", type: "enum", enum: ["MAXLEN"], optional: true }, { name: "maxlen", type: "int", optional: true }], returns: "The index, an array with COUNT, or nil when not found." },

  // --- sets ---
  { name: "SADD", group: "set", arity: -3, summary: "Add one or more members to a set", since: "1.0.0", access: "write", complexity: "O(1) per member", args: [{ name: "key", type: "key" }, { name: "member", type: "string", multiple: true }], returns: "Number of members that were added (not already present)." },
  { name: "SREM", group: "set", arity: -3, summary: "Remove one or more members from a set", since: "1.0.0", access: "write", complexity: "O(N)", args: [{ name: "key", type: "key" }, { name: "member", type: "string", multiple: true }], returns: "Number of members removed." },
  { name: "SMEMBERS", group: "set", arity: 2, summary: "Get every member of a set", since: "1.0.0", access: "read", complexity: "O(N)", args: [{ name: "key", type: "key" }], returns: "Array of members.", notes: "Reads the entire set; prefer SSCAN for large sets." },
  { name: "SCARD", group: "set", arity: 2, summary: "Count the members of a set", since: "1.0.0", access: "read", complexity: "O(1)", args: [{ name: "key", type: "key" }], returns: "Cardinality, 0 when missing." },
  { name: "SISMEMBER", group: "set", arity: 3, summary: "Check whether a member belongs to a set", since: "1.0.0", access: "read", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "member", type: "string" }], returns: "1 member · 0 not a member." },
  { name: "SMISMEMBER", group: "set", arity: -3, summary: "Check membership of multiple members", since: "6.2.0", access: "read", complexity: "O(N)", args: [{ name: "key", type: "key" }, { name: "member", type: "string", multiple: true }], returns: "Array of 1/0 per member." },
  { name: "SPOP", group: "set", arity: -2, summary: "Remove and return one or more random members", since: "1.0.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "count", type: "int", optional: true }], returns: "The member (or array with count), nil when empty." },
  { name: "SRANDMEMBER", group: "set", arity: -2, summary: "Return one or more random members without removing them", since: "1.0.0", access: "read", complexity: "O(N)", args: [{ name: "key", type: "key" }, { name: "count", type: "int", optional: true }], returns: "A member, or an array when count is given (negative counts allow repeats)." },
  { name: "SMOVE", group: "set", arity: 4, summary: "Move a member from one set to another", since: "1.0.0", access: "write", complexity: "O(1)", args: [{ name: "source", type: "key" }, { name: "destination", type: "key" }, { name: "member", type: "string" }], returns: "1 moved · 0 not a member of the source." },
  { name: "SDIFF", group: "set", arity: -2, summary: "Get the members present in the first set but not the others", since: "1.0.0", access: "read", complexity: "O(N)", args: [{ name: "key", type: "key", multiple: true }], returns: "Array of members." },
  { name: "SDIFFSTORE", group: "set", arity: -3, summary: "Store the difference of sets in a new key", since: "1.0.0", access: "write", complexity: "O(N)", args: [{ name: "destination", type: "key" }, { name: "key", type: "key", multiple: true }], returns: "Cardinality of the resulting set." },
  { name: "SINTER", group: "set", arity: -2, summary: "Get the members present in every given set", since: "1.0.0", access: "read", complexity: "O(N*M)", args: [{ name: "key", type: "key", multiple: true }], returns: "Array of members." },
  { name: "SINTERSTORE", group: "set", arity: -3, summary: "Store the intersection of sets in a new key", since: "1.0.0", access: "write", complexity: "O(N*M)", args: [{ name: "destination", type: "key" }, { name: "key", type: "key", multiple: true }], returns: "Cardinality of the resulting set." },
  { name: "SUNION", group: "set", arity: -2, summary: "Get the members of the union of sets", since: "1.0.0", access: "read", complexity: "O(N)", args: [{ name: "key", type: "key", multiple: true }], returns: "Array of members." },
  { name: "SUNIONSTORE", group: "set", arity: -3, summary: "Store the union of sets in a new key", since: "1.0.0", access: "write", complexity: "O(N)", args: [{ name: "destination", type: "key" }, { name: "key", type: "key", multiple: true }], returns: "Cardinality of the resulting set." },
  { name: "SSCAN", group: "set", arity: -3, summary: "Incrementally iterate set members", since: "2.8.0", access: "read", complexity: "O(1) per call", args: [{ name: "key", type: "key" }, { name: "cursor", type: "int" }, { name: "MATCH", type: "enum", enum: ["MATCH"], optional: true }, { name: "pattern", type: "pattern", optional: true }, { name: "COUNT", type: "enum", enum: ["COUNT"], optional: true }, { name: "count", type: "int", optional: true }], returns: "[next-cursor, [members…]]." },

  // --- sorted sets ---
  { name: "ZADD", group: "sorted-set", arity: -4, summary: "Add members with scores to a sorted set, updating existing members", since: "1.2.0", access: "write", complexity: "O(log(N)) per member", args: [{ name: "key", type: "key" }, { name: "flags", type: "enum", enum: ["NX", "XX", "GT", "LT", "CH", "INCR"], optional: true, multiple: true, description: "NX new only · XX existing only · GT/LT update conditionally · CH count changed · INCR increment" }, { name: "score", type: "double", multiple: true, description: "score/member pairs repeat" }, { name: "member", type: "string", interleaved: true }], returns: "Number added (or changed with CH), or the new score with INCR.", notes: "GT, LT and NX are mutually exclusive." },
  { name: "ZCARD", group: "sorted-set", arity: 2, summary: "Count the members of a sorted set", since: "1.2.0", access: "read", complexity: "O(1)", args: [{ name: "key", type: "key" }], returns: "Cardinality, 0 when missing." },
  { name: "ZCOUNT", group: "sorted-set", arity: 4, summary: "Count members with scores inside a range", since: "2.0.0", access: "read", complexity: "O(log(N))", args: [{ name: "key", type: "key" }, { name: "min", type: "string", description: 'score or "-inf", "(" for exclusive' }, { name: "max", type: "string", description: 'score or "+inf", "(" for exclusive' }], returns: "Member count." },
  { name: "ZINCRBY", group: "sorted-set", arity: 4, summary: "Increment a member's score", since: "1.2.0", access: "write", complexity: "O(log(N))", args: [{ name: "key", type: "key" }, { name: "increment", type: "double" }, { name: "member", type: "string" }], returns: "The member's new score as a string." },
  { name: "ZSCORE", group: "sorted-set", arity: 3, summary: "Get a member's score", since: "1.2.0", access: "read", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "member", type: "string" }], returns: "The score as a string, or nil." },
  { name: "ZMSCORE", group: "sorted-set", arity: -3, summary: "Get the scores of multiple members", since: "6.2.0", access: "read", complexity: "O(N)", args: [{ name: "key", type: "key" }, { name: "member", type: "string", multiple: true }], returns: "Array of scores, nil for unknown members." },
  { name: "ZRANK", group: "sorted-set", arity: -3, summary: "Get a member's ascending rank (lowest score first)", since: "2.0.0", access: "read", complexity: "O(log(N))", args: [{ name: "key", type: "key" }, { name: "member", type: "string" }, { name: "WITHSCORE", type: "enum", enum: ["WITHSCORE"], optional: true }], returns: "The 0-based rank, or nil." },
  { name: "ZREVRANK", group: "sorted-set", arity: -3, summary: "Get a member's descending rank (highest score first)", since: "2.0.0", access: "read", complexity: "O(log(N))", args: [{ name: "key", type: "key" }, { name: "member", type: "string" }, { name: "WITHSCORE", type: "enum", enum: ["WITHSCORE"], optional: true }], returns: "The 0-based rank, or nil." },
  { name: "ZRANGE", group: "sorted-set", arity: -4, summary: "Return members in a sorted set within an index, score, or lexicographic range", since: "6.2.0", access: "read", complexity: "O(log(N)+M) where M is the number of elements returned", args: [{ name: "key", type: "key" }, { name: "start", type: "int" }, { name: "stop", type: "int" }, { name: "modifier", type: "enum", enum: ["BYSCORE", "BYLEX", "REV"], optional: true }, { name: "WITHSCORES", type: "enum", enum: ["WITHSCORES"], optional: true }, { name: "LIMIT", type: "enum", enum: ["LIMIT"], optional: true, description: "With BYSCORE/BYLEX only" }, { name: "offset", type: "int", optional: true }, { name: "count", type: "int", optional: true }], returns: "Members (with scores when WITHSCORES) in ascending order unless REV.", notes: "With REV the start/stop indexes are from the highest score." },
  { name: "ZREVRANGE", group: "sorted-set", arity: 4, summary: "Return members by index from highest to lowest score", since: "1.2.0", access: "read", complexity: "O(log(N)+M)", args: [{ name: "key", type: "key" }, { name: "start", type: "int" }, { name: "stop", type: "int" }, { name: "WITHSCORES", type: "enum", enum: ["WITHSCORES"], optional: true }], returns: "Array of members." },
  { name: "ZRANGEBYSCORE", group: "sorted-set", arity: -4, summary: "Return members with scores inside a range", since: "1.0.1", access: "read", complexity: "O(log(N)+M)", args: [{ name: "key", type: "key" }, { name: "min", type: "string" }, { name: "max", type: "string" }, { name: "WITHSCORES", type: "enum", enum: ["WITHSCORES"], optional: true }, { name: "LIMIT", type: "enum", enum: ["LIMIT"], optional: true }, { name: "offset", type: "int", optional: true }, { name: "count", type: "int", optional: true }], returns: "Array of members." },
  { name: "ZREVRANGEBYSCORE", group: "sorted-set", arity: -4, summary: "Return members with scores inside a range, highest first", since: "2.2.0", access: "read", complexity: "O(log(N)+M)", args: [{ name: "key", type: "key" }, { name: "max", type: "string" }, { name: "min", type: "string" }, { name: "WITHSCORES", type: "enum", enum: ["WITHSCORES"], optional: true }, { name: "LIMIT", type: "enum", enum: ["LIMIT"], optional: true }, { name: "offset", type: "int", optional: true }, { name: "count", type: "int", optional: true }], returns: "Array of members." },
  { name: "ZRANGEBYLEX", group: "sorted-set", arity: -4, summary: "Return members in a lexicographic range (all scores equal)", since: "2.8.9", access: "read", complexity: "O(log(N)+M)", args: [{ name: "key", type: "key" }, { name: "min", type: "string", description: '"[" inclusive · "(" exclusive · "-" start' }, { name: "max", type: "string", description: '"[" inclusive · "(" exclusive · "+" end' }, { name: "LIMIT", type: "enum", enum: ["LIMIT"], optional: true }, { name: "offset", type: "int", optional: true }, { name: "count", type: "int", optional: true }], returns: "Array of members." },
  { name: "ZREM", group: "sorted-set", arity: -3, summary: "Remove one or more members from a sorted set", since: "1.2.0", access: "write", complexity: "O(M*log(N))", args: [{ name: "key", type: "key" }, { name: "member", type: "string", multiple: true }], returns: "Number of members removed." },
  { name: "ZREMRANGEBYRANK", group: "sorted-set", arity: 4, summary: "Remove members within an index range", since: "2.0.0", access: "write", complexity: "O(log(N)+M)", args: [{ name: "key", type: "key" }, { name: "start", type: "int" }, { name: "stop", type: "int" }], returns: "Number of members removed." },
  { name: "ZREMRANGEBYSCORE", group: "sorted-set", arity: 4, summary: "Remove members within a score range", since: "1.2.0", access: "write", complexity: "O(log(N)+M)", args: [{ name: "key", type: "key" }, { name: "min", type: "string" }, { name: "max", type: "string" }], returns: "Number of members removed." },
  { name: "ZREMRANGEBYLEX", group: "sorted-set", arity: 4, summary: "Remove members within a lexicographic range", since: "2.8.9", access: "write", complexity: "O(log(N)+M)", args: [{ name: "key", type: "key" }, { name: "min", type: "string" }, { name: "max", type: "string" }], returns: "Number of members removed." },
  { name: "ZPOPMIN", group: "sorted-set", arity: -2, summary: "Remove and return the members with the lowest scores", since: "5.0.0", access: "write", complexity: "O(log(N)*M)", args: [{ name: "key", type: "key" }, { name: "count", type: "int", optional: true }], returns: "Members with scores." },
  { name: "ZPOPMAX", group: "sorted-set", arity: -2, summary: "Remove and return the members with the highest scores", since: "5.0.0", access: "write", complexity: "O(log(N)*M)", args: [{ name: "key", type: "key" }, { name: "count", type: "int", optional: true }], returns: "Members with scores." },
  { name: "ZRANDMEMBER", group: "sorted-set", arity: -2, summary: "Return one or more random members", since: "6.2.0", access: "read", complexity: "O(N)", args: [{ name: "key", type: "key" }, { name: "count", type: "int", optional: true }, { name: "WITHSCORES", type: "enum", enum: ["WITHSCORES"], optional: true }], returns: "A member or array of members." },
  { name: "BZPOPMIN", group: "sorted-set", arity: -3, summary: "Remove and return the member with the lowest score, blocking if needed", since: "5.0.0", access: "write", complexity: "O(log(N))", blocking: true, args: [{ name: "key", type: "key", multiple: true }, { name: "timeout", type: "int", description: "Seconds; 0 blocks indefinitely" }], returns: "[key, member, score] or nil after the timeout.", notes: "Holds the client connection; timeout 0 blocks forever." },
  { name: "BZPOPMAX", group: "sorted-set", arity: -3, summary: "Remove and return the member with the highest score, blocking if needed", since: "5.0.0", access: "write", complexity: "O(log(N))", blocking: true, args: [{ name: "key", type: "key", multiple: true }, { name: "timeout", type: "int", description: "Seconds; 0 blocks indefinitely" }], returns: "[key, member, score] or nil after the timeout.", notes: "Holds the client connection; timeout 0 blocks forever." },
  { name: "ZLEXCOUNT", group: "sorted-set", arity: 4, summary: "Count members in a lexicographic range", since: "2.8.9", access: "read", complexity: "O(log(N))", args: [{ name: "key", type: "key" }, { name: "min", type: "string" }, { name: "max", type: "string" }], returns: "Member count." },
  { name: "ZSCAN", group: "sorted-set", arity: -3, summary: "Incrementally iterate sorted-set members and scores", since: "2.8.0", access: "read", complexity: "O(1) per call", args: [{ name: "key", type: "key" }, { name: "cursor", type: "int" }, { name: "MATCH", type: "enum", enum: ["MATCH"], optional: true }, { name: "pattern", type: "pattern", optional: true }, { name: "COUNT", type: "enum", enum: ["COUNT"], optional: true }, { name: "count", type: "int", optional: true }], returns: "[next-cursor, [member, score, …]]." },
  { name: "ZUNIONSTORE", group: "sorted-set", arity: -4, summary: "Store the union of sorted sets with aggregated scores", since: "2.0.0", access: "write", complexity: "O(N)+O(M log M)", args: [{ name: "destination", type: "key" }, { name: "numkeys", type: "int" }, { name: "key", type: "key", multiple: true }, { name: "WEIGHTS", type: "enum", enum: ["WEIGHTS"], optional: true }, { name: "weight", type: "double", optional: true, multiple: true }, { name: "AGGREGATE", type: "enum", enum: ["AGGREGATE"], optional: true }, { name: "aggregate", type: "enum", enum: ["SUM", "MIN", "MAX"], optional: true }], returns: "Cardinality of the resulting sorted set." },
  { name: "ZINTERSTORE", group: "sorted-set", arity: -4, summary: "Store the intersection of sorted sets with aggregated scores", since: "2.0.0", access: "write", complexity: "O(N*M) worst case", args: [{ name: "destination", type: "key" }, { name: "numkeys", type: "int" }, { name: "key", type: "key", multiple: true }, { name: "WEIGHTS", type: "enum", enum: ["WEIGHTS"], optional: true }, { name: "weight", type: "double", optional: true, multiple: true }, { name: "AGGREGATE", type: "enum", enum: ["AGGREGATE"], optional: true }, { name: "aggregate", type: "enum", enum: ["SUM", "MIN", "MAX"], optional: true }], returns: "Cardinality of the resulting sorted set." },
  { name: "ZDIFF", group: "sorted-set", arity: -3, summary: "Return members of the first sorted set minus the others", since: "6.2.0", access: "read", complexity: "O(N)", args: [{ name: "numkeys", type: "int" }, { name: "key", type: "key", multiple: true }, { name: "WITHSCORES", type: "enum", enum: ["WITHSCORES"], optional: true }], returns: "Array of members." },

  // --- streams ---
  { name: "XADD", group: "stream", arity: -5, summary: "Append an entry to a stream, creating it when needed", since: "5.0.0", access: "write", complexity: "O(1)", args: [{ name: "key", type: "key" }, { name: "flags", type: "enum", enum: ["NOMKSTREAM"], optional: true }, { name: "MAXLEN", type: "enum", enum: ["MAXLEN", "MINID"], optional: true, description: "Trim the stream while appending" }, { name: "threshold", type: "string", optional: true }, { name: "id", type: "string", description: '"*" auto-generates the entry id' }, { name: "field", type: "string", multiple: true, description: "field/value pairs repeat" }, { name: "value", type: "string", interleaved: true }], returns: "The new entry id." },
  { name: "XLEN", group: "stream", arity: 2, summary: "Count the entries in a stream", since: "5.0.0", access: "read", complexity: "O(1)", args: [{ name: "key", type: "key" }], returns: "Entry count, 0 when missing." },
  { name: "XRANGE", group: "stream", arity: -4, summary: "Return stream entries within an id range", since: "5.0.0", access: "read", complexity: "O(N) with N returned", args: [{ name: "key", type: "key" }, { name: "start", type: "string", description: 'id, "-" for the smallest' }, { name: "end", type: "string", description: 'id, "+" for the largest; "(" prefix excludes (6.2+)' }, { name: "COUNT", type: "enum", enum: ["COUNT"], optional: true }, { name: "count", type: "int", optional: true }], returns: "Entries as [id, [field, value, …]]." },
  { name: "XREVRANGE", group: "stream", arity: -4, summary: "Return stream entries in reverse within an id range", since: "5.0.0", access: "read", complexity: "O(N) with N returned", args: [{ name: "key", type: "key" }, { name: "end", type: "string", description: 'id, "+" for the largest' }, { name: "start", type: "string", description: 'id, "-" for the smallest; "(" prefix excludes (6.2+)' }, { name: "COUNT", type: "enum", enum: ["COUNT"], optional: true }, { name: "count", type: "int", optional: true }], returns: "Entries as [id, [field, value, …]]." },
  { name: "XREAD", group: "stream", arity: -3, summary: "Read entries from one or more streams, optionally blocking for new ones", since: "5.0.0", access: "read", complexity: "O(N) with N returned", blocking: true, args: [{ name: "COUNT", type: "enum", enum: ["COUNT"], optional: true }, { name: "count", type: "int", optional: true }, { name: "BLOCK", type: "enum", enum: ["BLOCK"], optional: true }, { name: "milliseconds", type: "int", optional: true, description: "0 blocks indefinitely" }, { name: "STREAMS", type: "enum", enum: ["STREAMS"] }, { name: "key", type: "key", multiple: true }, { name: "id", type: "string", multiple: true, description: '"$" waits for new entries' }], returns: "Per-stream entry arrays, or nil on timeout." },
  { name: "XDEL", group: "stream", arity: -3, summary: "Remove entries by id from a stream", since: "5.0.0", access: "write", complexity: "O(1) per id", args: [{ name: "key", type: "key" }, { name: "id", type: "string", multiple: true }], returns: "Number of entries removed." },
  { name: "XTRIM", group: "stream", arity: -4, summary: "Trim a stream to a maximum length or id threshold", since: "5.0.0", access: "write", complexity: "O(N)", args: [{ name: "key", type: "key" }, { name: "strategy", type: "enum", enum: ["MAXLEN", "MINID"] }, { name: "threshold", type: "string" }, { name: "LIMIT", type: "enum", enum: ["LIMIT"], optional: true }, { name: "count", type: "int", optional: true }], returns: "Number of entries removed." },
  { name: "XACK", group: "stream", arity: -4, summary: "Acknowledge processed messages of a consumer group", since: "5.0.0", access: "write", complexity: "O(1) per id", args: [{ name: "key", type: "key" }, { name: "group", type: "string" }, { name: "id", type: "string", multiple: true }], returns: "Number of messages acknowledged." },
  { name: "XGROUP", group: "stream", arity: -2, summary: "Create, destroy or manage consumer groups (CREATE, DESTROY, CREATECONSUMER, DELCONSUMER)", since: "5.0.0", access: "write", args: [{ name: "subcommand", type: "enum", enum: ["CREATE", "DESTROY", "CREATECONSUMER", "DELCONSUMER"] }, { name: "key", type: "key" }, { name: "group", type: "string" }, { name: "id-or-consumer", type: "string", optional: true }, { name: "MKSTREAM", type: "enum", enum: ["MKSTREAM"], optional: true }] },
  { name: "XINFO", group: "stream", arity: -2, summary: "Inspect streams and consumer groups (STREAM, GROUPS, CONSUMERS)", since: "5.0.0", access: "read", args: [{ name: "subcommand", type: "enum", enum: ["STREAM", "GROUPS", "CONSUMERS"] }, { name: "key", type: "key" }, { name: "group", type: "string", optional: true }] },

  // --- connection ---
  { name: "PING", group: "connection", arity: -1, summary: "Check the connection liveness", since: "1.0.0", access: "read", args: [{ name: "message", type: "string", optional: true }], returns: '"PONG", or the given message.' },
  { name: "ECHO", group: "connection", arity: 2, summary: "Echo the given string back", since: "1.0.0", access: "read", args: [{ name: "message", type: "string" }], returns: "The message." },
  { name: "SELECT", group: "connection", arity: 2, summary: "Switch the connection's logical database", since: "1.0.0", access: "write", args: [{ name: "index", type: "int" }], returns: '"OK".' },
  { name: "SWAPDB", group: "connection", arity: 3, summary: "Swap two logical databases atomically", since: "4.0.0", access: "write", args: [{ name: "index1", type: "int" }, { name: "index2", type: "int" }], returns: '"OK".' },
  { name: "AUTH", group: "connection", arity: -2, summary: "Authenticate the connection", since: "1.0.0", access: "read", args: [{ name: "username", type: "string", optional: true }, { name: "password", type: "string" }], returns: '"OK", or an error on bad credentials.' },
  { name: "HELLO", group: "connection", arity: -1, summary: "Switch protocol (RESP2/RESP3) and return server information", since: "6.0.0", access: "read", args: [{ name: "protover", type: "int", optional: true }, { name: "AUTH", type: "enum", enum: ["AUTH"], optional: true }, { name: "username", type: "string", optional: true }, { name: "password", type: "string", optional: true }, { name: "SETNAME", type: "enum", enum: ["SETNAME"], optional: true }, { name: "clientname", type: "string", optional: true }] },
  { name: "RESET", group: "connection", arity: 1, summary: "Reset the connection to a clean state", since: "6.2.0", access: "read", returns: '"RESET".' },
  { name: "CLIENT", group: "connection", arity: -2, summary: "Inspect or manage client connections", since: "2.2.3", access: "admin", danger: "admin", args: [{ name: "subcommand", type: "string", description: "LIST · INFO · ID · KILL · SETNAME …" }] },
  { name: "QUIT", group: "connection", arity: 1, summary: "Close the connection", since: "1.0.0", access: "read", returns: '"OK" then the connection closes.' },

  // --- server ---
  { name: "INFO", group: "server", arity: -1, summary: "Return server statistics and information sections", since: "1.0.0", access: "read", args: [{ name: "section", type: "string", optional: true, multiple: true, description: "server · clients · memory · persistence · stats · replication · cpu · cluster · keyspace" }] },
  { name: "COMMAND", group: "server", arity: -1, summary: "Introspect the server's command table", since: "2.8.13", access: "read", args: [{ name: "subcommand", type: "enum", enum: ["COUNT", "INFO", "DOCS", "GETKEYS", "LIST"], optional: true }, { name: "args", type: "string", optional: true, multiple: true }] },
  { name: "CONFIG", group: "server", arity: -2, summary: "Read or change server configuration", since: "2.0.0", access: "admin", danger: "config", args: [{ name: "subcommand", type: "enum", enum: ["GET", "SET", "RESETSTAT", "REWRITE"] }, { name: "parameter", type: "string", optional: true }, { name: "value", type: "string", optional: true }] },
  { name: "TIME", group: "server", arity: 1, summary: "Return the server's current time", since: "2.6.0", access: "read", returns: "[seconds-since-epoch, microseconds]." },
  { name: "LASTSAVE", group: "server", arity: 1, summary: "Return the Unix timestamp of the last successful RDB save", since: "1.0.0", access: "read" },
  { name: "BGSAVE", group: "server", arity: -1, summary: "Save the dataset to disk in the background", since: "1.0.0", access: "admin", danger: "admin" },
  { name: "BGREWRITEAOF", group: "server", arity: 1, summary: "Rewrite the append-only file in the background", since: "1.0.0", access: "admin", danger: "admin" },
  { name: "SAVE", group: "server", arity: 1, summary: "Save the dataset to disk, blocking all clients", since: "1.0.0", access: "admin", danger: "admin", notes: "Synchronous — blocks the server for the duration of the save." },
  { name: "SHUTDOWN", group: "server", arity: -1, summary: "Stop the server, optionally persisting first", since: "1.0.0", access: "admin", danger: "destructive", args: [{ name: "mode", type: "enum", enum: ["NOSAVE", "SAVE"], optional: true }] },
  { name: "DEBUG", group: "server", arity: -2, summary: "Server debugging subcommands (not for production use)", since: "1.0.0", access: "admin", danger: "admin" },
  { name: "MONITOR", group: "server", arity: 1, summary: "Stream every command the server processes", since: "1.0.0", access: "admin", danger: "admin", notes: "Degrades server performance; holds the connection forever." },
  { name: "SLAVEOF", group: "server", arity: 3, summary: "Make the server a replica of another, or stop replicating (deprecated alias of REPLICAOF)", since: "1.0.0", access: "admin", danger: "admin", args: [{ name: "host", type: "string" }, { name: "port", type: "string" }] },
  { name: "REPLICAOF", group: "server", arity: 3, summary: "Make the server a replica of another, or stop replicating", since: "5.0.0", access: "admin", danger: "admin", args: [{ name: "host", type: "string" }, { name: "port", type: "string" }] },
  { name: "WAIT", group: "server", arity: 3, summary: "Wait for the previous writes to reach N replicas", since: "3.0.0", access: "read", blocking: true, args: [{ name: "numreplicas", type: "int" }, { name: "timeout", type: "int", description: "Milliseconds; 0 waits indefinitely" }], returns: "Replicas that acknowledged the writes.", notes: "Holds the connection; timeout 0 blocks forever." },
  { name: "LOLWUT", group: "server", arity: -1, summary: "Display the server version as computer art", since: "5.0.0", access: "read" },

  // --- scripting ---
  { name: "EVAL", group: "scripting", arity: -3, summary: "Run a Lua script on the server", since: "2.6.0", access: "write", args: [{ name: "script", type: "string" }, { name: "numkeys", type: "int" }, { name: "key", type: "key", multiple: true }, { name: "arg", type: "string", multiple: true }], notes: "Scripts can read and write every key — treat as unbounded access." },
  { name: "EVALSHA", group: "scripting", arity: -3, summary: "Run a cached Lua script by its SHA1", since: "2.6.0", access: "write", args: [{ name: "sha1", type: "string" }, { name: "numkeys", type: "int" }, { name: "key", type: "key", multiple: true }, { name: "arg", type: "string", multiple: true }] },
  { name: "FCALL", group: "scripting", arity: -3, summary: "Run a server-side function", since: "7.0.0", access: "write", args: [{ name: "function", type: "string" }, { name: "numkeys", type: "int" }, { name: "key", type: "key", multiple: true }, { name: "arg", type: "string", multiple: true }] },
  { name: "FUNCTION", group: "scripting", arity: -2, summary: "Manage server-side functions (LOAD, LIST, DELETE, STATS, …)", since: "7.0.0", access: "write", args: [{ name: "subcommand", type: "string" }] },
  { name: "SCRIPT", group: "scripting", arity: -2, summary: "Manage the script cache (LOAD, EXISTS, FLUSH)", since: "2.6.0", access: "write", args: [{ name: "subcommand", type: "enum", enum: ["LOAD", "EXISTS", "FLUSH"] }, { name: "args", type: "string", optional: true, multiple: true }] },

  // --- pubsub ---
  { name: "PUBLISH", group: "pubsub", arity: 3, summary: "Post a message to a channel", since: "2.0.0", access: "write", args: [{ name: "channel", type: "string" }, { name: "message", type: "string" }], returns: "Number of clients that received the message." },
  { name: "SUBSCRIBE", group: "pubsub", arity: -2, summary: "Listen for messages on channels; holds the connection", since: "2.0.0", access: "read", args: [{ name: "channel", type: "string", multiple: true }], notes: "The connection enters subscribe mode until unsubscribed." },
  { name: "UNSUBSCRIBE", group: "pubsub", arity: -1, summary: "Stop listening on channels", since: "2.0.0", access: "read", args: [{ name: "channel", type: "string", optional: true, multiple: true }] },
  { name: "PSUBSCRIBE", group: "pubsub", arity: -2, summary: "Listen for messages on channel patterns; holds the connection", since: "2.0.0", access: "read", args: [{ name: "pattern", type: "pattern", multiple: true }] },
  { name: "PUNSUBSCRIBE", group: "pubsub", arity: -1, summary: "Stop listening on channel patterns", since: "2.0.0", access: "read", args: [{ name: "pattern", type: "pattern", optional: true, multiple: true }] },
  { name: "PUBSUB", group: "pubsub", arity: -2, summary: "Inspect the pub/sub subsystem (CHANNELS, NUMSUB, NUMPAT, SHARDCHANNELS)", since: "2.8.0", access: "read", args: [{ name: "subcommand", type: "enum", enum: ["CHANNELS", "NUMSUB", "NUMPAT", "SHARDCHANNELS", "SHARDNUMSUB"] }, { name: "pattern", type: "pattern", optional: true, multiple: true }] },

  // --- transactions ---
  { name: "MULTI", group: "transactions", arity: 1, summary: "Start a transaction; following commands queue until EXEC", since: "1.0.0", access: "write", returns: '"OK".' },
  { name: "EXEC", group: "transactions", arity: 1, summary: "Run all queued commands of a transaction atomically", since: "1.0.0", access: "write", returns: "Array of per-command replies, nil when WATCHed keys changed." },
  { name: "DISCARD", group: "transactions", arity: 1, summary: "Flush the queued transaction without running it", since: "2.0.0", access: "write", returns: '"OK".' },
  { name: "WATCH", group: "transactions", arity: -2, summary: "Watch keys; abort the transaction when they change before EXEC", since: "2.2.0", access: "write", args: [{ name: "key", type: "key", multiple: true }], returns: '"OK".' },
  { name: "UNWATCH", group: "transactions", arity: 1, summary: "Forget all watched keys", since: "2.2.0", access: "write", returns: '"OK".' },
];

const byName = new Map<string, CommandDoc>();

export function lookupCommand(name: string): CommandDoc | null {
  if (!byName.size) for (const doc of commandCatalog) byName.set(doc.name, doc);
  return byName.get(name.toUpperCase()) ?? null;
}

export function isWriteCommand(doc: CommandDoc | null): boolean {
  return doc !== null && doc.access !== "read";
}

// Resolve the blocking timeout (in seconds) for a blocking command's args.
// Returns null when the command is not blocking or the timeout is undetermined;
// 0 means "blocks indefinitely".
const BLOCKING_TIMEOUT: Record<string, "first" | "last"> = {
  BLPOP: "last", BRPOP: "last", BZPOPMIN: "last", BZPOPMAX: "last",
  BLMOVE: "last", BRPOPLPUSH: "last", BLMPOP: "first",
};

export function blockingTimeoutSeconds(doc: CommandDoc, args: string[]): number | null {
  if (!doc.blocking) return null;
  if (doc.name === "XREAD" || doc.name === "XREADGROUP") {
    // BLOCK must appear before STREAMS; a stream literally named "block" or
    // an id "block" is not the flag.
    const streams = args.findIndex(a => a.toUpperCase() === "STREAMS");
    if (streams === -1) return null;
    const idx = args.findIndex((a, i) => i < streams && a.toUpperCase() === "BLOCK");
    if (idx === -1 || idx + 1 >= streams) return null;
    const ms = Number(args[idx + 1]);
    return Number.isFinite(ms) ? ms / 1000 : null;
  }
  // WAIT/WAITAOF's timeout is milliseconds on the trailing argument.
  if (doc.name === "WAIT" || doc.name === "WAITAOF") {
    const ms = Number(args.at(-1));
    return Number.isFinite(ms) ? ms / 1000 : null;
  }
  const position = BLOCKING_TIMEOUT[doc.name];
  if (!position) return null;
  const raw = position === "last" ? args.at(-1) : args[0];
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : null;
}

// Pair every command token with the arg spec it fills. Handles the syntax
// shapes the catalog uses: fixed positions, repeated flags (enum multiple
// consumes only its own literals), trailing variadic keys, and interleaved
// pairs (HSET/MSET field,value · ZADD score,member · XADD field,value).
export function argRoles(doc: CommandDoc, args: string[]): { token: string; spec: CommandArgSpec | null }[] {
  const specs = doc.args ?? [];
  if (!specs.length) return args.map(token => ({ token, spec: null }));
  const roles: { token: string; spec: CommandArgSpec | null }[] = [];
  let token = 0;
  // A consumed "numkeys" argument bounds the variadic spec that follows
  // (EVAL's keys, ZUNIONSTORE's sources, LMPOP's keys).
  let numkeys: number | null = null;
  for (let s = 0; s < specs.length && token < args.length; s++) {
    const spec = specs[s]!;
    const next = specs[s + 1];
    if (spec.multiple) {
      if (spec.enum?.length) {
        // Repeated flags: consume only consecutive tokens that are one of the
        // spec's literals (e.g. ZADD's NX/GT/CH run before the score pairs).
        while (token < args.length && spec.enum.some(v => v.toUpperCase() === args[token]!.toUpperCase())) {
          roles.push({ token: args[token++]!, spec });
        }
        continue;
      }
      const interleaved = next?.interleaved === true;
      const laterRequired = specs.slice(s + 1).filter(a => !a.optional && !a.interleaved && !a.multiple).length;
      const end = s === specs.length - 1 ? args.length : args.length - laterRequired;
      if (interleaved) {
        while (token < end) {
          roles.push({ token: args[token]!, spec });
          if (args[token + 1] !== undefined) roles.push({ token: args[token + 1]!, spec: next! });
          token += 2;
        }
        s++; // the pair partner was consumed alongside
      } else {
        let stop = Math.max(token, end);
        if (numkeys !== null) stop = Math.min(stop, token + numkeys);
        else if (next?.multiple) {
          // Two consecutive variadic lists (XREAD's keys then ids) share the
          // tail evenly.
          stop = Math.min(stop, token + Math.ceil((args.length - token) / 2));
        }
        for (; token < stop; token++) roles.push({ token: args[token]!, spec });
        numkeys = null;
      }
    } else {
      const current = args[token]!;
      if (spec.optional && spec.enum?.length && !spec.enum.some(v => v.toUpperCase() === current.toUpperCase())) {
        // Absent optional flag: leave the token for the next spec, and skip
        // this flag's value spec(s) — the optional non-enum entries that
        // follow it (e.g. SCAN's pattern after MATCH, LIMIT's offset/count).
        while (s + 1 < specs.length && specs[s + 1]!.optional && !specs[s + 1]!.enum) s++;
        continue;
      }
      roles.push({ token: current, spec });
      if (spec.name === "numkeys") {
        const n = Number(current);
        numkeys = Number.isInteger(n) && n >= 0 ? n : null;
      }
      token++;
    }
  }
  for (; token < args.length; token++) roles.push({ token: args[token]!, spec: null });
  return roles;
}

// Keys referenced by a parsed command, derived from args specs (type "key").
// Exported for explain/lint cluster analysis and key-name autocompletion.
export function commandKeys(doc: CommandDoc, args: string[]): string[] {
  return argRoles(doc, args)
    .filter(r => r.spec?.type === "key")
    .map(r => r.token);
}
