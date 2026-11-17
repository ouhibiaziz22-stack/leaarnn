-- Server-only records for AI usage, payment verification, and immutable exam snapshots.
create unique index if not exists user_goals_user_id_key on public.user_goals(user_id);
create unique index if not exists subscriptions_user_id_key on public.subscriptions(user_id);
alter table public.assessment_attempts add column if not exists expires_at timestamptz;
create table if not exists public.exam_attempt_items (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.assessment_attempts(id) on delete cascade,
  question_id uuid not null references public.questions(id),
  position smallint not null,
  skill text not null,
  question_type text not null,
  prompt jsonb not null,
  correct_answer jsonb,
  cefr_target public.cefr_level,
  created_at timestamptz not null default now(),
  unique(attempt_id, question_id)
);
create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  provider text not null,
  provider_transaction_id text,
  invoice_id text not null unique,
  amount numeric(12,3) not null check(amount > 0),
  currency text not null default 'TND',
  status text not null default 'pending' check(status in ('pending','verified','failed','refunded')),
  raw_status jsonb,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique(provider, provider_transaction_id)
);
create table if not exists public.certificates (
  id uuid primary key default gen_random_uuid(),
  certificate_number text not null unique,
  user_id uuid not null references public.profiles(id),
  assessment_id uuid not null references public.assessments(id),
  title text not null,
  cefr_level public.cefr_level,
  issued_at timestamptz not null default now(),
  verification_token uuid not null unique default gen_random_uuid()
  ,unique(user_id, assessment_id)
);
alter table public.exam_attempt_items enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.certificates enable row level security;
create policy "own exam snapshots" on public.exam_attempt_items for select using(exists(select 1 from public.assessment_attempts a where a.id=attempt_id and a.user_id=auth.uid()));
create policy "own payments" on public.payment_transactions for select using(user_id=auth.uid() or public.is_admin());
create policy "own certificates" on public.certificates for select using(user_id=auth.uid() or public.is_admin());
create index if not exists exam_attempt_items_attempt_id on public.exam_attempt_items(attempt_id);
create index if not exists payment_transactions_user_id on public.payment_transactions(user_id, created_at desc);
create index if not exists certificates_user_id on public.certificates(user_id, issued_at desc);
revoke all on public.exam_attempt_items from anon, authenticated;
revoke all on public.payment_transactions from anon, authenticated;
revoke all on public.certificates from anon, authenticated;
