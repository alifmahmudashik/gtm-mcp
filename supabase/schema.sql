-- Run once in the Supabase SQL editor.
-- All access goes through the service-role key from the server, so RLS is on with no policies.

create table if not exists mcp_clients (
  client_id text primary key,
  client_name text,
  redirect_uris jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists oauth_pending (
  id text primary key,
  client_id text not null,
  redirect_uri text not null,
  state text,
  code_challenge text not null,
  scope text,
  resource text,
  created_at timestamptz not null default now()
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  google_refresh_token_enc text not null,
  google_access_token_enc text,
  google_access_expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists auth_codes (
  code_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  client_id text not null,
  redirect_uri text not null,
  code_challenge text not null,
  expires_at timestamptz not null
);

create table if not exists tokens (
  token_hash text primary key,
  kind text not null check (kind in ('access', 'refresh')),
  user_id uuid not null references users(id) on delete cascade,
  client_id text not null,
  expires_at timestamptz not null
);

alter table mcp_clients enable row level security;
alter table oauth_pending enable row level security;
alter table users enable row level security;
alter table auth_codes enable row level security;
alter table tokens enable row level security;

-- Newer Supabase projects don't auto-grant table privileges to the API roles, so the
-- service-role key gets "permission denied" (42501) without these. anon/authenticated get nothing.
grant usage on schema public to service_role;
grant select, insert, update, delete on mcp_clients, oauth_pending, users, auth_codes, tokens to service_role;

-- Optional housekeeping: delete expired rows (run on a Supabase cron if you like)
-- delete from tokens where expires_at < now();
-- delete from auth_codes where expires_at < now();
-- delete from oauth_pending where created_at < now() - interval '1 hour';
