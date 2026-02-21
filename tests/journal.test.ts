/**
 * Session Journal Tests
 *
 * Run: node --import tsx tests/journal.test.ts
 */

import assert from "node:assert";
import { SessionJournal } from "../src/journal.js";

console.log("🧪 Running journal tests...\n");

// Event extraction — creation patterns
{
  const journal = new SessionJournal();
  const events = journal.extractEvents(
    "I created the login component and implemented the auth flow for the dashboard."
  );
  assert.ok(events.length >= 1);
  assert.ok(events.some((e) => e.toLowerCase().includes("created")));
  console.log("✅ Extracts creation events");
}

// Event extraction — fix patterns
{
  const journal = new SessionJournal();
  const events = journal.extractEvents(
    "I fixed the authentication bug that was causing session timeouts."
  );
  assert.ok(events.length >= 1);
  assert.ok(events.some((e) => e.toLowerCase().includes("fixed")));
  console.log("✅ Extracts fix events");
}

// Event extraction — completion patterns
{
  const journal = new SessionJournal();
  const events = journal.extractEvents(
    "I completed the migration of all database tables to the new schema."
  );
  assert.ok(events.length >= 1);
  assert.ok(events.some((e) => e.toLowerCase().includes("completed")));
  console.log("✅ Extracts completion events");
}

// Event extraction — update patterns
{
  const journal = new SessionJournal();
  const events = journal.extractEvents(
    "I updated the configuration file to include the new API endpoints."
  );
  assert.ok(events.length >= 1);
  assert.ok(events.some((e) => e.toLowerCase().includes("updated")));
  console.log("✅ Extracts update events");
}

// Event extraction — success patterns
{
  const journal = new SessionJournal();
  const events = journal.extractEvents(
    "Successfully deployed the application to production environment."
  );
  assert.ok(events.length >= 1);
  assert.ok(events.some((e) => e.toLowerCase().includes("successfully")));
  console.log("✅ Extracts success events");
}

// Event extraction — tool usage patterns
{
  const journal = new SessionJournal();
  const events = journal.extractEvents(
    "I ran the test suite and all tests passed successfully."
  );
  assert.ok(events.length >= 1);
  console.log("✅ Extracts tool usage events");
}

// Event extraction — short/invalid content ignored
{
  const journal = new SessionJournal();
  const events = journal.extractEvents("I fixed it");
  assert.strictEqual(events.length, 0, "Too short to extract");

  const events2 = journal.extractEvents("");
  assert.strictEqual(events2.length, 0);

  const events3 = journal.extractEvents(null as any);
  assert.strictEqual(events3.length, 0);
  console.log("✅ Short/invalid content produces no events");
}

// Trigger phrase detection
{
  const journal = new SessionJournal();
  assert.strictEqual(journal.needsContext("What did you do earlier?"), true);
  assert.strictEqual(journal.needsContext("Can you summarize your work?"), true);
  assert.strictEqual(journal.needsContext("Remind me what we did today"), true);
  assert.strictEqual(journal.needsContext("What is the capital of France?"), false);
  assert.strictEqual(journal.needsContext("Write a function to sort arrays"), false);
  assert.strictEqual(journal.needsContext(""), false);
  assert.strictEqual(journal.needsContext(null as any), false);
  console.log("✅ Trigger phrase detection works correctly");
}

// Recording and formatting
{
  const journal = new SessionJournal();
  journal.record("sess-1", ["I created the login page", "I fixed the auth bug"], "gpt-4o");
  const entries = journal.getEntries("sess-1");
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].action, "I created the login page");
  assert.strictEqual(entries[0].model, "gpt-4o");

  const formatted = journal.format("sess-1");
  assert.ok(formatted);
  assert.ok(formatted.includes("[Session Memory - Key Actions]"));
  assert.ok(formatted.includes("I created the login page"));
  assert.ok(formatted.includes("I fixed the auth bug"));
  console.log("✅ Recording and formatting works");
}

// Empty journal returns null
{
  const journal = new SessionJournal();
  assert.strictEqual(journal.format("nonexistent"), null);
  console.log("✅ Empty journal returns null format");
}

// Recording with empty events is a no-op
{
  const journal = new SessionJournal();
  journal.record("sess-1", []);
  assert.strictEqual(journal.getEntries("sess-1").length, 0);
  console.log("✅ Empty events recording is no-op");
}

// Max entries limit
{
  const journal = new SessionJournal({ maxEntries: 5 });
  const events = Array.from({ length: 10 }, (_, i) => `Event number ${i + 1} happened`);
  journal.record("sess-1", events);
  const entries = journal.getEntries("sess-1");
  assert.strictEqual(entries.length, 5, "Should be capped at maxEntries");
  // Should keep the latest entries
  assert.ok(entries[entries.length - 1].action.includes("10"));
  console.log("✅ Max entries limit enforced");
}

// Max age limit
{
  const journal = new SessionJournal({ maxAgeMs: 50 });
  journal.record("sess-1", ["Old event that should expire"]);

  await new Promise((r) => setTimeout(r, 60));

  // Recording new events should trim the old ones
  journal.record("sess-1", ["Fresh new event just now"]);
  const entries = journal.getEntries("sess-1");
  assert.strictEqual(entries.length, 1);
  assert.ok(entries[0].action.includes("Fresh"));
  console.log("✅ Max age limit enforced");
}

// Clear and stats
{
  const journal = new SessionJournal();
  journal.record("sess-1", ["Action one for sess one"]);
  journal.record("sess-2", ["Action one for sess two", "Action two for sess two"]);

  const stats = journal.getStats();
  assert.strictEqual(stats.sessions, 2);
  assert.strictEqual(stats.totalEntries, 3);

  journal.clear("sess-1");
  assert.strictEqual(journal.getEntries("sess-1").length, 0);
  assert.strictEqual(journal.getEntries("sess-2").length, 2);

  journal.clearAll();
  assert.strictEqual(journal.getStats().sessions, 0);
  console.log("✅ Clear and stats work correctly");
}

console.log("\n🎉 All journal tests passed!\n");
