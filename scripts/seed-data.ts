import { TZDate } from "@date-fns/tz";
import { addDays, startOfDay, startOfWeek, subDays } from "date-fns";
import type { Database } from "../src/storage/database.js";
import type { FactInput, Source } from "../src/types.js";

/**
 * Back-dated demo conversations for the challenge questions, placed relative
 * to "now" so the demo works on any date:
 *   - Postgres hosting prices: Tuesday of last week   (Tue 3 Nov when run on Wed 11 Nov)
 *   - 5-tool CRM shortlist:    most recent Monday      (Mon 9 Nov)
 *   - Unrelated Lisbon trip:   yesterday               (Tue 10 Nov), so "last Tuesday" is genuinely ambiguous
 * The prices are a snapshot of what an assistant might have said then; the live agent re-checks them.
 */

interface SeedExchange {
  user: string;
  assistant: string;
  sources?: Source[];
  facts?: FactInput[];
}

interface SeedConversation {
  id: string;
  title: string;
  day: (today: TZDate) => TZDate;
  hour: number;
  exchanges: SeedExchange[];
}

export const SEED_PREFIX = "seed-";

const conversations: SeedConversation[] = [
  {
    id: `${SEED_PREFIX}postgres-hosting`,
    title: "Managed Postgres hosting prices",
    // Tuesday of the previous calendar week
    day: (today) => addDays(subDays(startOfWeek(today, { weekStartsOn: 1 }), 7), 1),
    hour: 10,
    exchanges: [
      {
        user: "I need managed Postgres hosting for a small SaaS (about 10 GB of data, light traffic). Compare Neon, Supabase, Render and AWS RDS on price.",
        assistant: `For ~10 GB and light traffic, here's what each costs today:

| Provider | Plan | Price | Notes |
|---|---|---|---|
| **Neon** | Launch | **$19/mo** | 10 GB storage included, autoscaling compute, scales to zero [1] |
| **Supabase** | Pro | **$25/mo** | 8 GB database included, then $0.125/GB; includes $10 compute credit [2] |
| **Render** | Basic-1gb | **$19/mo** | 1 GB RAM; storage billed at $0.30/GB [3] |
| **AWS RDS** | db.t4g.micro (Single-AZ) | **~$12/mo** + ~$1.15 for 10 GB gp3 | No free tier after 12 months [4] |

**Pick:** Neon Launch for the lowest effort at this size; RDS if you're already on AWS and want the cheapest steady-state bill.`,
        sources: [
          { n: 1, title: "Neon pricing", url: "https://neon.com/pricing" },
          { n: 2, title: "Supabase pricing", url: "https://supabase.com/pricing" },
          { n: 3, title: "Render pricing", url: "https://render.com/pricing" },
          {
            n: 4,
            title: "Amazon RDS for PostgreSQL pricing",
            url: "https://aws.amazon.com/rds/postgresql/pricing/",
          },
        ],
        facts: [
          {
            entity: "Neon",
            attribute: "Launch plan price",
            value: "$19/mo (10 GB storage included)",
            source_url: "https://neon.com/pricing",
          },
          {
            entity: "Supabase",
            attribute: "Pro plan price",
            value: "$25/mo (8 GB database included, $0.125/GB after)",
            source_url: "https://supabase.com/pricing",
          },
          {
            entity: "Render",
            attribute: "Postgres Basic-1gb price",
            value: "$19/mo, storage $0.30/GB",
            source_url: "https://render.com/pricing",
          },
          {
            entity: "AWS RDS",
            attribute: "db.t4g.micro PostgreSQL price",
            value: "~$12/mo + gp3 storage ~$0.115/GB-month",
            source_url: "https://aws.amazon.com/rds/postgresql/pricing/",
          },
        ],
      },
      {
        user: "Does Neon's free plan work for a staging database?",
        assistant:
          "Yes. Neon's Free plan gives 0.5 GB storage per project and scales compute to zero when idle, which is fine for staging. Expect a cold start of a few hundred milliseconds after idle periods [1].",
        sources: [{ n: 1, title: "Neon pricing", url: "https://neon.com/pricing" }],
        facts: [
          {
            entity: "Neon",
            attribute: "Free plan storage",
            value: "0.5 GB per project",
            source_url: "https://neon.com/pricing",
          },
        ],
      },
    ],
  },
  {
    id: `${SEED_PREFIX}crm-shortlist`,
    title: "CRM shortlist for a 6-person sales team",
    // Most recent Monday strictly before today
    day: (today) => {
      const diff = (today.getDay() - 1 + 7) % 7 || 7;
      return subDays(today, diff);
    },
    hour: 15,
    exchanges: [
      {
        user: "We're a 6-person B2B sales team moving off spreadsheets. Shortlist 5 CRM tools with per-seat pricing.",
        assistant: `Here's a shortlist of 5 CRMs that fit a 6-person B2B team:

1. **HubSpot Sales Hub Starter**: $20/seat/mo (annual). Best free-to-paid path and marketing integration [1]
2. **Pipedrive Essential**: $14/seat/mo (annual). Simplest pipeline UI, strong for deal tracking [2]
3. **Attio Plus**: $29/seat/mo (annual). Flexible data model, modern UI, good for founder-led sales [3]
4. **Folk Standard**: $20/seat/mo (annual). Lightweight, great for relationship-driven outreach [4]
5. **Zoho CRM Standard**: $14/user/mo (annual). Cheapest full-featured option [5]

For 6 seats that's roughly $84–$174/month. Start trials with Pipedrive and Attio.`,
        sources: [
          { n: 1, title: "HubSpot pricing", url: "https://www.hubspot.com/pricing/sales" },
          { n: 2, title: "Pipedrive pricing", url: "https://www.pipedrive.com/en/pricing" },
          { n: 3, title: "Attio pricing", url: "https://attio.com/pricing" },
          { n: 4, title: "Folk pricing", url: "https://www.folk.app/pricing" },
          { n: 5, title: "Zoho CRM pricing", url: "https://www.zoho.com/crm/zohocrm-pricing.html" },
        ],
        facts: [
          { entity: "CRM shortlist", attribute: "tools", value: "HubSpot, Pipedrive, Attio, Folk, Zoho CRM" },
          {
            entity: "HubSpot Sales Hub",
            attribute: "Starter price",
            value: "$20/seat/mo (annual)",
            source_url: "https://www.hubspot.com/pricing/sales",
          },
          {
            entity: "Pipedrive",
            attribute: "Essential price",
            value: "$14/seat/mo (annual)",
            source_url: "https://www.pipedrive.com/en/pricing",
          },
          {
            entity: "Attio",
            attribute: "Plus price",
            value: "$29/seat/mo (annual)",
            source_url: "https://attio.com/pricing",
          },
          {
            entity: "Folk",
            attribute: "Standard price",
            value: "$20/seat/mo (annual)",
            source_url: "https://www.folk.app/pricing",
          },
          {
            entity: "Zoho CRM",
            attribute: "Standard price",
            value: "$14/user/mo (annual)",
            source_url: "https://www.zoho.com/crm/zohocrm-pricing.html",
          },
        ],
      },
    ],
  },
  {
    id: `${SEED_PREFIX}lisbon`,
    title: "Weekend in Lisbon",
    day: (today) => subDays(today, 1),
    hour: 19,
    exchanges: [
      {
        user: "Plan a relaxed 2-day weekend in Lisbon for food and views.",
        assistant: `**Day 1:** Alfama in the morning, Miradouro de Santa Luzia, lunch at Time Out Market, sunset at Miradouro da Senhora do Monte.
**Day 2:** Belém (Pastéis de Belém, Jerónimos Monastery), LX Factory in the afternoon, dinner in Bairro Alto.`,
      },
    ],
  },
];

export interface SeededMessage {
  id: number;
  text: string;
}

export interface SeedResult {
  messages: SeededMessage[];
  /** Conversation title → ISO start time. */
  days: Record<string, string>;
}

/** Time between a seeded question and its answer, and between exchanges. */
const ANSWER_DELAY_MS = 25_000;
const NEXT_QUESTION_DELAY_MS = 4 * 60_000;

/** Removes previous demo data and inserts it again. Returns the created messages (for embedding). */
export function seedDemo(db: Database, options: { now: number; timezone: string }): SeedResult {
  const { timezone } = options;
  const today = startOfDay(new TZDate(options.now, timezone));
  const result: SeedResult = { messages: [], days: {} };

  db.transaction(() => {
    for (const conversation of db.conversations.list(10_000)) {
      if (conversation.id.startsWith(SEED_PREFIX)) db.conversations.delete(conversation.id);
    }

    for (const seed of conversations) {
      const day = seed.day(today);
      const start = new TZDate(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        seed.hour,
        0,
        timezone,
      ).getTime();
      result.days[seed.title] = new Date(start).toISOString();
      db.conversations.create({ id: seed.id, title: seed.title, timezone, createdAt: start });

      let time = start;
      for (const exchange of seed.exchanges) {
        const question = db.messages.append({
          conversationId: seed.id,
          role: "user",
          text: exchange.user,
          createdAt: time,
        });
        time += ANSWER_DELAY_MS;

        const answer = db.messages.append({
          conversationId: seed.id,
          role: "assistant",
          text: exchange.assistant,
          sources: exchange.sources,
          createdAt: time,
        });
        if (exchange.facts?.length) {
          db.facts.insert({
            conversationId: seed.id,
            messageId: answer.id,
            observedAt: time,
            facts: exchange.facts,
          });
        }

        result.messages.push({ id: question.id, text: question.text }, { id: answer.id, text: answer.text });
        time += NEXT_QUESTION_DELAY_MS;
      }
    }
  });

  return result;
}
