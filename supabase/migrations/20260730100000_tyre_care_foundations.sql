-- Tyre-care foundations (#596, docs/tyre-care-build-spec.md, PR 2).
-- Persist the mileage + wheel evidence the recommendation engine (PR 3+)
-- needs: MOT test history (odometer + defects, currently fetched live and
-- thrown away), a job-visit odometer, tread checks joined to their visit,
-- rotation-eligibility profile, and a log of when rotation/alignment/
-- balancing actually happened.

-- ── MOT test history ─────────────────────────────────────────────────────────
-- One row per (vehicle, test date). Written by the nightly delta cron and the
-- on-demand lookup write-through; odometer normalised to miles at ingest.
-- Same-day retests collapse onto one row (last write wins — dedupe in code
-- prefers the PASSED result); one reading per day is plenty for the mileage
-- model.

create table if not exists public.mot_tests (
  id              uuid primary key default gen_random_uuid(),
  vehicle_id      uuid not null references public.vehicles(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  test_date       date not null,
  result          text,
  odometer_miles  integer,
  defects         jsonb not null default '[]',
  source          text not null check (source in ('lookup', 'delta')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (vehicle_id, test_date)
);

create index if not exists mot_tests_org_idx on public.mot_tests (organization_id);

alter table public.mot_tests enable row level security;

-- Customer-global data: vehicles are visible org-wide, so their MOT history
-- is too. Writes are cron/server-side only (admin client).
create policy "mot_tests_org_read" on public.mot_tests
  for select to authenticated
  using (private.is_org_staff(organization_id));

-- ── Job odometer ─────────────────────────────────────────────────────────────
-- Prompt-but-allow capture at each visit; the freshest anchor the mileage
-- estimate re-anchors to.

alter table public.jobs add column if not exists odometer_miles integer;

-- ── tyre_checks: join to the visit + odometer + org scope ────────────────────
-- Baseline table predates org tenancy: no organization_id, no vehicle index,
-- no link to the job that produced the reading.

alter table public.tyre_checks
  add column if not exists organization_id uuid references public.organizations(id) on delete cascade,
  add column if not exists job_id uuid references public.jobs(id) on delete set null,
  add column if not exists odometer_miles integer;

update public.tyre_checks tc
set organization_id = l.organization_id
from public.locations l
where l.id = tc.location_id
  and tc.organization_id is null;

create trigger set_org_from_location
  before insert on public.tyre_checks
  for each row execute function private.set_org_from_location();

create index if not exists tyre_checks_vehicle_idx
  on public.tyre_checks (vehicle_id, checked_at desc);

-- Vehicles are customer-global; a reading taken at branch A must be readable
-- by staff of branch B (the existing policy is location-member only).
create policy "tyre_checks_org_read" on public.tyre_checks
  for select to authenticated
  using (organization_id is not null and private.is_org_staff(organization_id));

-- ── Rotation-eligibility profile ─────────────────────────────────────────────
-- Staff-captured; 'unknown' rows block the approve button in the review
-- queue, not evaluation. rotation_eligible derives in code (standard only).

create table if not exists public.vehicle_wheel_profile (
  vehicle_id      uuid primary key references public.vehicles(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  tyre_config     text not null default 'unknown'
                    check (tyre_config in ('standard', 'directional', 'staggered', 'unknown')),
  notes           text,
  recorded_by     uuid references auth.users(id) on delete set null,
  updated_at      timestamptz not null default now()
);

create index if not exists vehicle_wheel_profile_org_idx
  on public.vehicle_wheel_profile (organization_id);

alter table public.vehicle_wheel_profile enable row level security;

create policy "vehicle_wheel_profile_org_read" on public.vehicle_wheel_profile
  for select to authenticated
  using (private.is_org_staff(organization_id));

-- ── Wheel service events ─────────────────────────────────────────────────────
-- When rotation/alignment/balancing actually happened — the cooldown anchor
-- ("never recommend a service performed within 3 months / 3,000 miles").

create table if not exists public.wheel_service_events (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null references public.locations(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete cascade,
  vehicle_id      uuid not null references public.vehicles(id) on delete cascade,
  service_type    text not null check (service_type in ('rotation', 'alignment', 'balance')),
  performed_at    date not null default current_date,
  odometer_miles  integer,
  job_id          uuid references public.jobs(id) on delete set null,
  recorded_by     uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists wheel_service_events_vehicle_idx
  on public.wheel_service_events (vehicle_id, performed_at desc);
create index if not exists wheel_service_events_location_idx
  on public.wheel_service_events (location_id);

create trigger set_org_from_location
  before insert on public.wheel_service_events
  for each row execute function private.set_org_from_location();

alter table public.wheel_service_events enable row level security;

create policy "wheel_service_events_member_all" on public.wheel_service_events
  for all to authenticated
  using (private.is_location_member(location_id))
  with check (private.is_location_member(location_id));

-- Cross-branch visibility: the vehicle page shows events from every branch.
create policy "wheel_service_events_org_read" on public.wheel_service_events
  for select to authenticated
  using (organization_id is not null and private.is_org_staff(organization_id));
