/**
 * Database schema. Constraints enforce the state guards in docs/03 §3.11 where SQL can express
 * them (single owner per state, one open case per participant, closure evidence and approvals,
 * append-only audit). Times are timestamptz and always supplied by the application clock.
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: String.raw`
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('host', 'partner', 'operator')),
  status text NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'live', 'closed')),
  timezone text NOT NULL DEFAULT 'America/New_York',
  day_start_min int NOT NULL DEFAULT 480 CHECK (day_start_min BETWEEN 0 AND 1439),
  day_end_min int NOT NULL DEFAULT 1020 CHECK (day_end_min BETWEEN 1 AND 1440),
  work_days int[] NOT NULL DEFAULT '{1,2,3,4,5}',
  public_phone text,
  sms_number text UNIQUE,
  coordinator_id uuid,
  deputy_id uuid,
  program_lead_id uuid,
  enrollment_paused boolean NOT NULL DEFAULT false,
  enrollment_pause_reason text,
  hold_active boolean NOT NULL DEFAULT false,
  hold_reason text,
  hold_started_at timestamptz,
  hold_confirmed_at timestamptz,
  photos_enabled boolean NOT NULL DEFAULT false,
  continuity_partner_id uuid REFERENCES organizations(id),
  committed_hours numeric NOT NULL DEFAULT 12,
  police_nonemergency_phone text,
  dss_adult_phone text,
  dss_child_phone text,
  created_at timestamptz NOT NULL,
  CHECK (day_end_min > day_start_min)
);

CREATE TABLE org_holidays (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  day date NOT NULL,
  label text,
  PRIMARY KEY (org_id, day)
);

CREATE TABLE org_readiness (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  item text NOT NULL,
  completed_at timestamptz NOT NULL,
  completed_by uuid NOT NULL,
  reference text NOT NULL,
  PRIMARY KEY (org_id, item)
);

CREATE TABLE staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  work_phone text,
  password_hash text NOT NULL,
  totp_secret_enc bytea,
  totp_enabled boolean NOT NULL DEFAULT false,
  recovery_hashes text[] NOT NULL DEFAULT '{}',
  roles text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  out_from date,
  out_to date,
  failed_signins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_signin_at timestamptz,
  notify_sms boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  CHECK (roles <@ ARRAY['recorder','enroller','responder','coordinator','program_lead','relay','steward','operator','evaluator']::text[])
);
ALTER TABLE organizations ADD FOREIGN KEY (coordinator_id) REFERENCES staff(id);
ALTER TABLE organizations ADD FOREIGN KEY (deputy_id) REFERENCES staff(id);
ALTER TABLE organizations ADD FOREIGN KEY (program_lead_id) REFERENCES staff(id);

CREATE TABLE staff_training (
  staff_id uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  module int NOT NULL CHECK (module BETWEEN 1 AND 10),
  completed_at timestamptz NOT NULL,
  recorded_by uuid NOT NULL REFERENCES staff(id),
  PRIMARY KEY (staff_id, module)
);

CREATE TABLE sessions (
  id_hash text PRIMARY KEY,
  staff_id uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  mfa_ok boolean NOT NULL DEFAULT false,
  shared_device boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);

CREATE TABLE participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  hosted_since timestamptz NOT NULL,
  code text NOT NULL UNIQUE,
  phone_checkin_id text UNIQUE,
  training boolean NOT NULL DEFAULT false,
  name_enc bytea NOT NULL,
  other_names_enc bytea,
  lookup text NOT NULL DEFAULT 'name' CHECK (lookup IN ('name', 'code_only')),
  birth_year int CHECK (birth_year BETWEEN 1900 AND 2100),
  languages text,
  accessibility_enc bytea,
  verification_hash text,
  keypad_pin_hash text,
  verification_failures int NOT NULL DEFAULT 0,
  verification_locked_until timestamptz,
  primary_responder_id uuid REFERENCES staff(id),
  backup_responder_id uuid REFERENCES staff(id),
  state text NOT NULL CHECK (state IN ('draft','active','paused','withdrawal_pending','withdrawn','transfer_pending','transferred','inactive','ended')),
  state_changed_at timestamptz NOT NULL,
  activated_at timestamptz,
  clock_base_at timestamptz,
  clock_return boolean NOT NULL DEFAULT false,
  tell_pending boolean NOT NULL DEFAULT false,
  last_qualifying_at timestamptz,
  last_qualifying_kind text,
  last_qualifying_confidence text,
  last_in_person_at timestamptz,
  withdrawal_requested_at timestamptz,
  withdrawal_review_due timestamptz,
  withdrawal_extended boolean NOT NULL DEFAULT false,
  keep_after_withdrawal boolean NOT NULL DEFAULT false,
  delete_after timestamptz,
  legal_hold text,
  photo_enc bytea,
  self_view_code_hash text,
  self_view_code_expires timestamptz,
  created_by uuid NOT NULL REFERENCES staff(id),
  created_at timestamptz NOT NULL
);
CREATE INDEX participants_org ON participants(org_id, state);

-- Participant data keys. May live in a separate database (KEYSTORE_DATABASE_URL) so that
-- deleting a key also makes that participant's data in ordinary backups unreadable.
CREATE TABLE access_grants (
  session_hash text NOT NULL REFERENCES sessions(id_hash) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  reason text NOT NULL,
  granted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (session_hash, participant_id)
);

CREATE TABLE participant_keys (
  participant_id uuid PRIMARY KEY,
  wrapped_key bytea NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  script_version text NOT NULL,
  choices jsonb NOT NULL,
  teach_back boolean NOT NULL,
  method text NOT NULL CHECK (method IN ('in_person', 'remote')),
  witnessed_by uuid NOT NULL REFERENCES staff(id),
  created_at timestamptz NOT NULL
);

CREATE TABLE plan_versions (
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  version int NOT NULL,
  interval_days int NOT NULL CHECK (interval_days IN (7, 14, 30)),
  grace_days int NOT NULL CHECK (grace_days BETWEEN 0 AND 30),
  qualifying_kinds text[] NOT NULL,
  followup text[] NOT NULL,
  phone_enc bytea,
  phone_index text,
  phone_verified_at timestamptz,
  phone_call boolean NOT NULL DEFAULT false,
  phone_text boolean NOT NULL DEFAULT false,
  phone_voicemail boolean NOT NULL DEFAULT false,
  phone_message_enc bytea,
  avoid_times_enc bytea,
  usually_found_enc bytea,
  named_people_enc bytea,
  partner_message_enc bytea,
  tell_me_if_asked boolean NOT NULL DEFAULT true,
  disaster_priority boolean NOT NULL DEFAULT false,
  disaster_category text CHECK (disaster_category IN ('mobility', 'medical', 'other')),
  continuity_sharing boolean NOT NULL DEFAULT false,
  sms_checkins boolean NOT NULL DEFAULT false,
  sms_reminders boolean NOT NULL DEFAULT false,
  sms_consent_at timestamptz,
  keypad_checkins boolean NOT NULL DEFAULT false,
  changed_by uuid REFERENCES staff(id),
  change_channel text NOT NULL CHECK (change_channel IN ('in_person', 'remote')),
  changed_fields text[] NOT NULL DEFAULT '{}',
  remote_unconfirmed boolean NOT NULL DEFAULT false,
  confirmed_in_person_at timestamptz,
  effective_from timestamptz NOT NULL,
  superseded_at timestamptz,
  values_purged boolean NOT NULL DEFAULT false,
  PRIMARY KEY (participant_id, version),
  CHECK (followup <@ ARRAY['records','phone','places','people','partners']::text[]),
  CHECK (qualifying_kinds <@ ARRAY['in_person','phone_with_staff','relay','self_check_in']::text[])
);
CREATE INDEX plan_phone_index ON plan_versions(phone_index) WHERE superseded_at IS NULL;

CREATE TABLE pauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  channel text NOT NULL CHECK (channel IN ('in_person', 'remote')),
  created_by uuid NOT NULL REFERENCES staff(id),
  ended_at timestamptz,
  CHECK (ends_at > starts_at)
);

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('in_person','phone_with_staff','relay','self_check_in','secondhand')),
  confidence text NOT NULL CHECK (confidence IN ('known','verified','code_only','stated','reported')),
  source text NOT NULL CHECK (source IN ('staff','relay','sms','keypad','offline','continuity')),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  recorded_by uuid REFERENCES staff(id),
  recorded_org uuid REFERENCES organizations(id),
  qualifying boolean NOT NULL,
  needs_approval boolean NOT NULL DEFAULT false,
  approved_by uuid REFERENCES staff(id),
  approval_reason text,
  note_enc bytea,
  relay_message_enc bytea,
  voided_at timestamptz,
  voided_by uuid REFERENCES staff(id),
  void_reason text,
  CHECK (occurred_at <= recorded_at + interval '5 minutes'),
  CHECK (kind <> 'secondhand' OR confidence = 'reported'),
  CHECK (note_enc IS NULL OR kind IN ('self_check_in', 'secondhand')),
  CHECK (relay_message_enc IS NULL OR kind = 'relay')
);
CREATE INDEX contacts_participant ON contacts(participant_id, occurred_at DESC);

CREATE TABLE cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  trigger text NOT NULL CHECK (trigger IN ('overdue', 'concern', 'roll_call')),
  state text NOT NULL CHECK (state IN ('offered','uncovered','accepted','stalled','extended_watch','contact_reported','closed')),
  opened_at timestamptz NOT NULL,
  overdue_at timestamptz,
  owner_id uuid REFERENCES staff(id),
  offeree_id uuid REFERENCES staff(id),
  chain_step text CHECK (chain_step IN ('primary','backup','coordinator','deputy','program_lead','named')),
  offered_at timestamptz,
  offer_expires_at timestamptz,
  uncovered_since timestamptz,
  accepted_at timestamptz,
  last_action_at timestamptz,
  stalled_at timestamptz,
  stall_deadline timestamptz,
  ew_since timestamptz,
  ew_next_review timestamptz,
  reported_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  contact_reported_at timestamptz,
  prior_state text,
  withdrawal_pending boolean NOT NULL DEFAULT false,
  priority int NOT NULL DEFAULT 0,
  closure_reason text CHECK (closure_reason IN ('contact_restored','contact_restored_self_report','recording_gap','withdrawn','transferred','reported_deceased','ended_after_extended_follow_up','other_documented')),
  closure_contact_kind text,
  closure_contact_confidence text,
  closed_at timestamptz,
  closed_by uuid REFERENCES staff(id),
  approved_by uuid REFERENCES staff(id),
  second_reviewer uuid REFERENCES staff(id),
  deceased_source text CHECK (deceased_source IN ('official_notification', 'next_of_kin_confirmed', 'staff_confirmed')),
  closure_note_enc bytea,
  reopen_count int NOT NULL DEFAULT 0,
  notes_purged boolean NOT NULL DEFAULT false,
  CHECK (state = 'offered' OR offeree_id IS NULL),
  CHECK (state <> 'offered' OR (offeree_id IS NOT NULL AND owner_id IS NULL)),
  CHECK (state <> 'uncovered' OR (offeree_id IS NULL AND owner_id IS NULL)),
  CHECK (state NOT IN ('accepted','stalled','extended_watch','contact_reported') OR (owner_id IS NOT NULL AND offeree_id IS NULL)),
  CHECK ((state = 'closed') = (closure_reason IS NOT NULL)),
  CHECK (closure_reason NOT IN ('reported_deceased','ended_after_extended_follow_up','other_documented') OR approved_by IS NOT NULL),
  CHECK (closure_reason <> 'reported_deceased' OR (second_reviewer IS NOT NULL AND deceased_source IS NOT NULL AND second_reviewer <> closed_by)),
  CHECK (closure_reason NOT IN ('contact_restored','contact_restored_self_report','recording_gap') OR closure_contact_kind IS NOT NULL)
);
CREATE UNIQUE INDEX one_open_case ON cases(participant_id) WHERE state <> 'closed';
CREATE INDEX cases_org_state ON cases(org_id, state);

CREATE TABLE case_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES staff(id),
  step text NOT NULL,
  offered_at timestamptz NOT NULL,
  accepted_at timestamptz,
  declined_at timestamptz,
  decline_reason text,
  expired_at timestamptz,
  released_at timestamptz,
  release_reason text
);

CREATE TABLE case_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES staff(id),
  at timestamptz NOT NULL,
  action text NOT NULL CHECK (action IN ('checked_records','asked_host_staff','called','texted','left_voicemail','visited_usual_place','asked_named_person','asked_partner_org','other','review')),
  source text NOT NULL CHECK (source IN ('participant','host_staff','partner_staff','named_person','other_person','none')),
  result text NOT NULL CHECK (result IN ('no_information','lead','contact_restored','impossible')),
  certainty text NOT NULL CHECK (certainty IN ('low','medium','high')),
  note_enc bytea
);

CREATE TABLE closure_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  reason text NOT NULL,
  deceased_source text,
  note_enc bytea,
  proposed_by uuid NOT NULL REFERENCES staff(id),
  proposed_at timestamptz NOT NULL,
  reviewed_by uuid REFERENCES staff(id),
  reviewed_at timestamptz,
  decided_by uuid REFERENCES staff(id),
  decided_at timestamptz,
  decision text CHECK (decision IN ('approved','rejected'))
);

CREATE TABLE concerns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL,
  source_category text NOT NULL CHECK (source_category IN ('family','friend','other_org','other')),
  callback_enc bytea,
  callback_delete_at timestamptz,
  linked_case_id uuid REFERENCES cases(id) ON DELETE SET NULL,
  participant_told_at timestamptz,
  recorded_by uuid NOT NULL REFERENCES staff(id)
);

CREATE TABLE conflicts (
  staff_id uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('staff_declared','participant_requested')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (staff_id, participant_id)
);

CREATE TABLE transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  from_org uuid NOT NULL REFERENCES organizations(id),
  to_org uuid NOT NULL REFERENCES organizations(id),
  include_other_names boolean NOT NULL,
  include_named_people boolean NOT NULL,
  created_by uuid NOT NULL REFERENCES staff(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','accepted','declined','expired')),
  decided_by uuid REFERENCES staff(id),
  decided_at timestamptz,
  CHECK (from_org <> to_org)
);

-- Required abuse reports (docs/safeguarding-reports.md). Staff make the report themselves by
-- phone; Heartbeat sends nothing to anyone and records only that the report was made. There is no
-- immigration category, by policy.
CREATE TABLE safeguarding_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  participant_id uuid REFERENCES participants(id) ON DELETE SET NULL,
  case_id uuid REFERENCES cases(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN ('child_abuse', 'intimate_partner_abuse', 'disabled_adult')),
  recipient text NOT NULL CHECK (recipient IN ('police', 'dss_child', 'dss_adult')),
  identified_by uuid NOT NULL REFERENCES staff(id),
  identified_at timestamptz NOT NULL,
  made_by uuid REFERENCES staff(id),
  made_at timestamptz,
  reference text,
  delete_after timestamptz
);

CREATE TABLE continuity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_org uuid NOT NULL REFERENCES organizations(id),
  partner_org uuid NOT NULL REFERENCES organizations(id),
  reason text NOT NULL,
  requested_by uuid NOT NULL REFERENCES staff(id),
  approved_by uuid REFERENCES staff(id),
  starts_at timestamptz,
  ends_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE TABLE relay_attempts (
  id bigserial PRIMARY KEY,
  staff_id uuid NOT NULL REFERENCES staff(id),
  code_hash text NOT NULL,
  at timestamptz NOT NULL,
  ok boolean NOT NULL
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid REFERENCES staff(id) ON DELETE CASCADE,
  operator_email text,
  org_id uuid REFERENCES organizations(id),
  case_id uuid REFERENCES cases(id) ON DELETE SET NULL,
  kind text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  dedupe_key text,
  created_at timestamptz NOT NULL,
  sent_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  attempts int NOT NULL DEFAULT 0,
  error text
);
CREATE UNIQUE INDEX notifications_dedupe ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE sms_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  participant_id uuid REFERENCES participants(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  purpose text NOT NULL,
  provider_id text,
  status text NOT NULL,
  dedupe_key text,
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX sms_dedupe ON sms_messages(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE phone_codes (
  participant_id uuid PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0
);

CREATE TABLE sms_optouts (
  org_id uuid NOT NULL REFERENCES organizations(id),
  phone_index text NOT NULL,
  at timestamptz NOT NULL,
  PRIMARY KEY (org_id, phone_index)
);

CREATE TABLE job_runs (
  id bigserial PRIMARY KEY,
  job text NOT NULL,
  org_id uuid REFERENCES organizations(id),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  ok boolean,
  summary jsonb
);
CREATE INDEX job_runs_recent ON job_runs(job, org_id, started_at DESC);

CREATE TABLE monthly_aggregates (
  org_id uuid NOT NULL REFERENCES organizations(id),
  week date NOT NULL,
  metric text NOT NULL,
  value numeric NOT NULL,
  PRIMARY KEY (org_id, week, metric)
);

CREATE TABLE access_reviews (
  org_id uuid NOT NULL REFERENCES organizations(id),
  month text NOT NULL,
  signed_by uuid NOT NULL REFERENCES staff(id),
  signed_at timestamptz NOT NULL,
  note text,
  PRIMARY KEY (org_id, month)
);

CREATE TABLE time_logs (
  staff_id uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  week date NOT NULL,
  hours numeric NOT NULL CHECK (hours >= 0 AND hours <= 80),
  PRIMARY KEY (staff_id, week)
);

CREATE TABLE tombstones (
  participant_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  enrolled_month text,
  ended_month text NOT NULL,
  end_reason text NOT NULL,
  deleted_at timestamptz NOT NULL
);

CREATE TABLE breakglass_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  requested_by uuid NOT NULL REFERENCES staff(id),
  approved_by uuid REFERENCES staff(id),
  ticket text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  approved_at timestamptz,
  expires_at timestamptz
);

-- Append-only audit trail with a hash chain. Only the redactable fields (participant_id,
-- search_terms, salt) may be cleared, and rows may be deleted only by the retention job.
CREATE TABLE audit_events (
  id bigint PRIMARY KEY,
  at timestamptz NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('staff', 'system', 'participant', 'provider')),
  actor_id uuid,
  actor_org uuid,
  action text NOT NULL,
  target_type text,
  target_id text,
  basis text,
  reason text,
  outcome text NOT NULL DEFAULT 'ok',
  details jsonb NOT NULL DEFAULT '{}',
  participant_id uuid,
  search_terms text,
  salt text,
  commit text NOT NULL,
  prev_hash text NOT NULL,
  hash text NOT NULL
);
CREATE SEQUENCE audit_seq;
CREATE INDEX audit_participant ON audit_events(participant_id, at) WHERE participant_id IS NOT NULL;
CREATE INDEX audit_at ON audit_events(at);

CREATE TABLE audit_checkpoints (
  day date PRIMARY KEY,
  last_id bigint NOT NULL,
  head_hash text NOT NULL,
  first_prev_hash text NOT NULL,
  count int NOT NULL,
  exported_at timestamptz NOT NULL
);

CREATE FUNCTION audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('heartbeat.audit_purge', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'audit events are append-only';
  END IF;
  IF NEW.id IS NOT DISTINCT FROM OLD.id AND NEW.at IS NOT DISTINCT FROM OLD.at
     AND NEW.actor_type IS NOT DISTINCT FROM OLD.actor_type AND NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id
     AND NEW.actor_org IS NOT DISTINCT FROM OLD.actor_org AND NEW.action IS NOT DISTINCT FROM OLD.action
     AND NEW.target_type IS NOT DISTINCT FROM OLD.target_type AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
     AND NEW.basis IS NOT DISTINCT FROM OLD.basis AND NEW.reason IS NOT DISTINCT FROM OLD.reason
     AND NEW.outcome IS NOT DISTINCT FROM OLD.outcome AND NEW.details IS NOT DISTINCT FROM OLD.details
     AND NEW.commit IS NOT DISTINCT FROM OLD.commit AND NEW.prev_hash IS NOT DISTINCT FROM OLD.prev_hash
     AND NEW.hash IS NOT DISTINCT FROM OLD.hash
     AND NEW.participant_id IS NULL AND NEW.search_terms IS NULL AND NEW.salt IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit events are append-only';
END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_guard();
`,
  },
];
