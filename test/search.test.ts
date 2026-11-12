import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSiteOperators, webSearchTool } from "../src/agent/search.js";

test("site: operators move into the domain filter", () => {
  assert.deepEqual(splitSiteOperators("site:neon.com/pricing Launch plan", []), { query: "Launch plan", domains: ["neon.com"] });
  // The model's frequent slip: "site." instead of "site:"
  assert.deepEqual(splitSiteOperators("site.supabase.com/pricing Pro 25", []), { query: "Pro 25", domains: ["supabase.com"] });
  assert.deepEqual(splitSiteOperators("pricing site:www.render.com", ["https://neon.com/x", "neon.com"]), {
    query: "pricing",
    domains: ["neon.com", "render.com"],
  });
  assert.deepEqual(splitSiteOperators("website: neon pricing", []), { query: "website: neon pricing", domains: [] }, "only a standalone site: operator");
  assert.equal(splitSiteOperators("x", ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com"]).domains.length, 5);
  assert.deepEqual(splitSiteOperators("x", ["not a domain", "localhost"]).domains, []);
});

test("tool schema stays strict-mode compatible", () => {
  const p = webSearchTool.parameters as any;
  assert.equal(p.additionalProperties, false);
  assert.deepEqual([...p.required].sort(), Object.keys(p.properties).sort(), "every property is required (nullable instead of optional)");
  assert.ok(p.properties.domains);
});
