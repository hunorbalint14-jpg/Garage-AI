# Wheel & tyre care recommendations — build spec (#596)

Mileage-driven rotation / alignment / balancing prompts. The pitch to the
customer is tyre lifespan; the value to the garage is evidence-backed
recurring revenue between MOTs. The design principle from the issue stands:
**every recommendation must be defensible** — evidence quality gates whether
we contact anyone at all.

**Architecture in one line: persist the mileage + tread evidence we already
see but currently throw away (MOT odometer readings, job odometer, tread
checks), run a pure rules engine over it on the `scheduled_tasks` fan-out,
write `tyre_recommendations` rows with structured evidence, and let staff
approve each send from a review queue — approval triggers the message with
consent, caps, and a booking deep-link that attributes the conversion.**

Everything rides existing rails: the deferred-work bank pattern (#498) for
lifecycle/token attribution, `tyre_checks` for tread data, `lookupMotHistory`
+ the nightly MOT delta cron for odometer series, the automations task UI for
per-garage config, and branch-identity comms (#367).

## Locked decisions (v1)

- **No auto-send.** Every message is staff-approved from the review queue;
  approval sends inline (like win-back). Confidence tier is stored on the row
  so auto-send for high-confidence recs can be revisited with conversion +
  complaint data. Because sends are staff-attended, no prelive `held_comms`
  kind is needed in v1 — that arrives with auto-send.
- **No zone-level tread capture** (inner/centre/outer). Alignment triggers
  run on axle differential, cross-axle differential, MOT advisory text
  matching, and event triggers (suspension/steering work, new tyres without
  alignment). Shoulder differential joins later if garages ask for it.
- **Balancing never messages the customer.** Weakest signal of the three —
  it surfaces as a point-of-service prompt on the job/booking screen only
  (new tyre fitted or wheel refurbished without a recorded balance).
- **Rotation eligibility** comes from a staff-captured `vehicle_wheel_profile`
  (staggered / directional / standard / unknown). Unknown blocks nothing in
  the queue but the approve button demands a profile first — the first
  rotation rec for a vehicle doubles as the capture moment. No external
  fitment API in v1.
- **Odometer capture is prompt-but-allow**, not blocking. A nag on the job
  card beats staff inventing numbers to get past a wall.
- **Routing: home branch.** Recs are customer-level scheduled care comms —
  same rule as MOT/service reminders (`customers.preferred_location_id`),
  branch identity in every message.
- **Compliance: this is marketing**, unlike the existing legitimate-interest
  crons. Per-channel consent (`marketing_email_consent` / `marketing_sms_consent`,
  `anonymized_at is null`) is checked at approval time, every email carries a
  one-click unsubscribe (net-new platform infra, reusable by campaigns and
  win-back), SMS carries an unsubscribe line pointing at the same landing
  page. Inbound SMS STOP webhook is a fast-follow, not v1.
- **Under-3-year-olds** (no MOT history): evaluated from in-house readings
  only, and only once the vehicle has ≥2 dated odometer points. Otherwise it
  counts against the coverage metric, not the recommendation queue.
- **MOT bundling**: no automatic bundling. The queue flags "MOT due in ≤45
  days" on the row so staff time the send; a rec suppressed by staff for
  bundling is `dismissed` with reason `bundle_with_mot`.

## Data model (PR 2 — foundations)

```sql
mot_tests (                          -- persist what lookupMotHistory already returns
  id, vehicle_id references vehicles on delete cascade,
  organization_id,                   -- trigger from vehicle? no — copy at insert
  test_date date not null, result text,
  odometer_miles integer,            -- normalised: KM readings converted
  advisories jsonb not null default '[]',  -- [{text, type}]
  source text check (source in ('lookup','delta')),
  unique (vehicle_id, test_date)
)
alter table jobs add column odometer_miles integer;      -- prompt-but-allow
alter table tyre_checks
  add column organization_id ...,    -- + set_org_from_location trigger
  add column job_id uuid references jobs on delete set null,
  add column odometer_miles integer; -- direct entry when no job context
create index tyre_checks_vehicle_idx on tyre_checks (vehicle_id, checked_at desc);

vehicle_wheel_profile (
  vehicle_id pk references vehicles on delete cascade,
  organization_id,
  tyre_config text check (tyre_config in ('standard','directional','staggered','unknown'))
    default 'unknown',
  rotation_eligible boolean generated / derived in code (standard only),
  notes text, recorded_by, updated_at
)

wheel_service_events (               -- when rotation/alignment/balance actually happened
  id, location_id, organization_id,  -- set_org_from_location
  vehicle_id, service_type text check (in ('rotation','alignment','balance')),
  performed_at date not null, odometer_miles integer,
  job_id uuid null references jobs on delete set null,
  recorded_by, created_at
)
```

MOT ingestion: (a) `extractDeltaUpdate` in `src/lib/dvsa-bulk.ts` stops
discarding `odometerValue`/`defects` — the nightly delta cron upserts
`mot_tests` rows at zero extra DVSA quota; (b) the existing on-demand
`lookupMotHistory` callers write-through the full history the first time a
vehicle is looked at (read-through cache → table, same idempotent upsert).

RLS: `mot_tests` org-scoped read (`private.is_org_staff`); the rest
operational (`private.is_location_member`), all `to authenticated`,
`(select auth.uid())` wrapped, writes via admin client. `tyre_checks` also
gains the org backfill.

## Rules engine (PR 3 — pure lib, vitest like `deferred-followup.test.ts`)

`src/lib/tyre-care.ts`, side-effect-free, `now` injected:

- `estimateMileage(points, now)` — weighted regression over all dated
  odometer points (mot_tests + jobs + tyre_checks + vehicle_history_entries),
  weighted toward the most recent 2–3; returns
  `{ estimatedNow, avgDailyMiles, confidence, pointCount }`. ≥2 points or
  no estimate. `estimated_mileage_now` renders on the vehicle page.
- **Powertrain multiplier** from `vehicles.fuel_type` (ELECTRICITY ≈ 0.8 ×
  interval, HYBRID ≈ 0.9, else 1.0) — shortens rotation/balance intervals.
- Triggers (issue thresholds, org-overridable):
  - **Rotation**: `miles_since_rotation ≥ interval` (default 6,000 mi ×
    multiplier) AND profile eligible; `cross_axle_diff ≥ 1.0mm` upgrades
    confidence to high.
  - **Alignment**: `axle_differential ≥ 1.5mm` · MOT advisory regex
    (uneven/edge/shoulder wear) · suspension/steering job without alignment
    event · new tyres (`*_replaced`) without alignment event.
  - **Balance** (staff prompt only): tyre replaced / wheel refurb without
    balance event · `miles_since_balance ≥ 12,000 mi`.
- **Cooldown**: no rec within 3 months or 3,000 miles of the matching
  `wheel_service_events` row, whichever is longer.
- Every trigger returns `evidence` jsonb:
  `{ rule_key, rule_version, inputs: {...}, reason }` where `reason` is the
  plain-English sentence that goes in the message ("~7,200 miles since your
  tyres were rotated").
- Confidence: `high` = tread/event/advisory evidence; `low` = mileage
  estimate alone. Both queue for staff; the tier is future auto-send gating.

## Recommendations + queue (PR 4)

```sql
tyre_recommendations (
  id, location_id /* home branch */, organization_id,
  customer_id, vehicle_id, service_type check (in ('rotation','alignment','balance')),
  confidence check (in ('high','low')), evidence jsonb not null,
  status check (in ('pending_review','approved_sent','dismissed','converted','expired'))
    default 'pending_review',
  dismissed_reason text, reviewed_by uuid, reviewed_at timestamptz,
  book_token_hash text, sent_at, converted_booking_id, converted_at,
  created_at, updated_at
)
-- one live row per (vehicle_id, service_type): code-level guard like planBankUpserts
```

- Cron: `scheduled_tasks` `task_type='tyre_care'` → `/api/cron/tyre-care`
  via tick (`TASK_ROUTE` + automations `TASK_META`/`ensureDefaultTasks`/
  `runTaskNow` + constraint widening — same four-place checklist as #498).
  Evaluation only, no sends. Global `tyre_care` feature flag, default off.
- Config: `organizations.tyre_rotation_miles int default 6000`,
  `tyre_balance_miles int default 12000` (org columns, precedent
  `deferred_followup_days`); channels via task `settings.channels`.
- Queue: `/staff/tyre-care` — pending rows with the evidence sentence,
  estimated mileage, confidence chip, MOT-due-soon flag, wheel-profile state;
  actions Approve & send / Dismiss (reason). Audit every action.
- Point-of-service balance prompt renders on the job card when the engine
  flags it (computed live, no row).

## Sends + attribution (PR 5)

- Approval action: consent per channel + 30-day / annual (default 6) caps
  checked server-side at click time — caps consult `reminders` +
  `review_requests` + `deferred_work.last_followup_at` (extends the #498
  union) — then AI-drafted email/SMS (Haiku, org brief, feature key
  `tyre_care_draft`, deterministic fallback), branch identity, unsubscribe.
  Sends log to `reminders` (type widened `'tyre_care'`) so every other cap
  union sees them.
- **Unsubscribe (platform infra)**: `/unsubscribe?u=<token>` — random
  32-byte token minted per customer, sha256 on `customers`; landing page
  flips the consent booleans per channel + `consent_updated_at` + audit.
  `sendEmail` gains optional `List-Unsubscribe` / one-click headers.
- Deep link: `/book?tc=<token>` — booking widget gains vehicle-registration
  prefill + service preselect (per-location service mapping optional in task
  settings; unmapped → vehicle-only prefill). Booking creation calls
  `markTyreRecConverted` (dw-token pattern verbatim). Expiry: token dies when
  the row leaves `approved_sent`.

## Metrics (PR 6)

Conversion per service type + confidence tier, attributed £, staff rejection
rate (false-positive proxy), unsubscribe rate, coverage (% active vehicles
with an estimate). Beta registry entry + dashboard tile + docs.

## Explicit MVP cuts

- Auto-send (even high confidence) · zone tread capture · SMS STOP webhook ·
  WhatsApp · external fitment API · tyre replacement recs (issue non-goal) ·
  business-hours/timezone send windows (staff click = the send window) ·
  MOT-bundled message content · per-customer snooze.

## Risks / repo gotchas that WILL bite

- Migration version: check latest on disk at PR time (parallel-PR collisions).
- Tick fan-out is a four-place checklist (constraint, TASK_ROUTE, automations
  actions, TASK_META) — miss one and the cron silently never runs.
- `reminders` type CHECK is NOT VALID — widen it or inserts fail loudly and
  dedup dies (20260609160000 comment).
- KM-unit MOT readings (imports, NI vehicles) must normalise to miles at
  ingest, not at read time.
- Mileage regression must ignore decreasing odometer pairs (clocking, typos,
  unit mixups) — clamp, don't average garbage.
- supabase-js lazy builders: fire-and-forget writes chain `.then()` (#523).
- Booking widget is public + CSP-constrained; `tc` token rides a hidden field
  through the stepper like `dw`.

## Acceptance (v1 subset of #596)

1. MOT odometer + advisories persist per vehicle; job odometer capture
   exists; estimated mileage shows on the vehicle record. (PR 2–3)
2. All three triggers evaluate on the scheduled task and write rows with
   evidence; rotation blocks on wheel profile; cooldown suppresses. (PR 3–4)
3. Staff queue lists pending recs with evidence; approve sends (consent +
   caps + unsubscribe enforced); dismiss records a reason. (PR 4–5)
4. Booking link prefills vehicle (+ service when mapped); conversion is
   attributed to the rec. (PR 5)
5. Thresholds configurable per org without deploy. (PR 4)

## Sizing

| PR | Scope | Size |
|---|---|---|
| 1 | This spec | — |
| 2 | mot_tests + delta/lookup ingestion + jobs.odometer + tyre_checks fixes + wheel profile + wheel_service_events | L |
| 3 | Pure rules engine + tests + vehicle-page mileage display | M |
| 4 | tyre_recommendations + cron + automations task + review queue + balance job-card prompt | L (the big one) |
| 5 | Approval sends + unsubscribe infra + booking prefill + attribution | L |
| 6 | Metrics + beta registry + docs | S |
