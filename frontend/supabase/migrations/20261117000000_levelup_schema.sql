-- LEVELUP English core schema. Run through Supabase migrations, never in the browser.
create type public.app_role as enum ('student', 'admin');
create type public.plan_key as enum ('free', 'premium', 'pro');
create type public.cefr_level as enum ('A1', 'A2', 'B1', 'B2', 'C1', 'C2');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role public.app_role not null default 'student',
  estimated_level public.cefr_level,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.user_goals (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
  goal text not null check (goal in ('work','education','travel','communication','exams')),
  daily_minutes smallint not null check (daily_minutes between 5 and 240), preferred_skills text[] not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
  plan public.plan_key not null default 'free', provider text, provider_subscription_id text unique,
  status text not null default 'active', current_period_end timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.courses (id uuid primary key default gen_random_uuid(), title text not null, description text, level public.cefr_level, published boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.modules (id uuid primary key default gen_random_uuid(), course_id uuid not null references public.courses(id) on delete cascade, title text not null, position smallint not null, created_at timestamptz not null default now(), unique(course_id,position));
create table public.lessons (id uuid primary key default gen_random_uuid(), module_id uuid not null references public.modules(id) on delete cascade, title text not null, content jsonb not null default '{}', position smallint not null, duration_minutes smallint, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(module_id,position));
create table public.exercises (id uuid primary key default gen_random_uuid(), lesson_id uuid not null references public.lessons(id) on delete cascade, exercise_type text not null, prompt jsonb not null, rubric jsonb, position smallint not null, created_at timestamptz not null default now());
create table public.assessments (id uuid primary key default gen_random_uuid(), title text not null, version text not null, is_placement boolean not null default false, published boolean not null default false, created_at timestamptz not null default now(), unique(title,version));
create table public.questions (id uuid primary key default gen_random_uuid(), assessment_id uuid not null references public.assessments(id) on delete cascade, skill text not null check (skill in ('grammar','vocabulary','reading','listening','writing','speaking')), question_type text not null, prompt jsonb not null, scoring_rubric jsonb, cefr_target public.cefr_level, position smallint not null, created_at timestamptz not null default now());
create table public.assessment_attempts (id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade, assessment_id uuid not null references public.assessments(id), status text not null default 'in_progress', overall_level public.cefr_level, started_at timestamptz not null default now(), completed_at timestamptz, created_at timestamptz not null default now());
create table public.answers (id uuid primary key default gen_random_uuid(), attempt_id uuid not null references public.assessment_attempts(id) on delete cascade, question_id uuid not null references public.questions(id), answer jsonb, score numeric(5,2), reviewer_id uuid references public.profiles(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(attempt_id,question_id));
create table public.skill_results (id uuid primary key default gen_random_uuid(), attempt_id uuid not null references public.assessment_attempts(id) on delete cascade, skill text not null, level public.cefr_level, score numeric(5,2), evidence jsonb not null default '{}', created_at timestamptz not null default now(), unique(attempt_id,skill));
create table public.lesson_completions (id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade, lesson_id uuid not null references public.lessons(id), progress numeric(5,2) not null default 0 check(progress between 0 and 100), completed_at timestamptz, updated_at timestamptz not null default now(), unique(user_id,lesson_id));
create table public.tutor_conversations (id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade, title text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.tutor_messages (id uuid primary key default gen_random_uuid(), conversation_id uuid not null references public.tutor_conversations(id) on delete cascade, role text not null check(role in ('user','assistant','system')), content text not null, created_at timestamptz not null default now());

create index on public.user_goals(user_id); create index on public.subscriptions(user_id); create index on public.modules(course_id); create index on public.lessons(module_id); create index on public.questions(assessment_id, skill); create index on public.assessment_attempts(user_id, created_at desc); create index on public.answers(attempt_id); create index on public.skill_results(attempt_id); create index on public.lesson_completions(user_id); create index on public.tutor_conversations(user_id); create index on public.tutor_messages(conversation_id);

create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$ select exists(select 1 from public.profiles where id = auth.uid() and role = 'admin') $$;
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$ begin insert into public.profiles(id,full_name) values(new.id,coalesce(new.raw_user_meta_data->>'full_name','')); insert into public.subscriptions(user_id,plan) values(new.id,'free'); return new; end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security; alter table public.user_goals enable row level security; alter table public.subscriptions enable row level security; alter table public.assessment_attempts enable row level security; alter table public.answers enable row level security; alter table public.skill_results enable row level security; alter table public.lesson_completions enable row level security; alter table public.tutor_conversations enable row level security; alter table public.tutor_messages enable row level security; alter table public.courses enable row level security; alter table public.modules enable row level security; alter table public.lessons enable row level security; alter table public.exercises enable row level security; alter table public.assessments enable row level security; alter table public.questions enable row level security;
create policy "own profile" on public.profiles for all using(id=auth.uid() or public.is_admin()) with check(id=auth.uid() or public.is_admin());
create policy "own goals" on public.user_goals for all using(user_id=auth.uid() or public.is_admin()) with check(user_id=auth.uid() or public.is_admin());
create policy "own subscriptions" on public.subscriptions for select using(user_id=auth.uid() or public.is_admin());
create policy "own attempts" on public.assessment_attempts for all using(user_id=auth.uid() or public.is_admin()) with check(user_id=auth.uid() or public.is_admin());
create policy "own answers" on public.answers for all using(exists(select 1 from public.assessment_attempts a where a.id=attempt_id and (a.user_id=auth.uid() or public.is_admin()))) with check(exists(select 1 from public.assessment_attempts a where a.id=attempt_id and (a.user_id=auth.uid() or public.is_admin())));
create policy "own skill results" on public.skill_results for select using(exists(select 1 from public.assessment_attempts a where a.id=attempt_id and (a.user_id=auth.uid() or public.is_admin())));
create policy "own completions" on public.lesson_completions for all using(user_id=auth.uid() or public.is_admin()) with check(user_id=auth.uid() or public.is_admin());
create policy "own conversations" on public.tutor_conversations for all using(user_id=auth.uid() or public.is_admin()) with check(user_id=auth.uid() or public.is_admin());
create policy "own messages" on public.tutor_messages for all using(exists(select 1 from public.tutor_conversations c where c.id=conversation_id and (c.user_id=auth.uid() or public.is_admin()))) with check(exists(select 1 from public.tutor_conversations c where c.id=conversation_id and (c.user_id=auth.uid() or public.is_admin())));
create policy "published learning content" on public.courses for select using(published or public.is_admin()); create policy "published modules" on public.modules for select using(exists(select 1 from public.courses c where c.id=course_id and (c.published or public.is_admin()))); create policy "published lessons" on public.lessons for select using(exists(select 1 from public.modules m join public.courses c on c.id=m.course_id where m.id=module_id and (c.published or public.is_admin()))); create policy "published exercises" on public.exercises for select using(true); create policy "published assessments" on public.assessments for select using(published or public.is_admin()); create policy "assessment questions" on public.questions for select using(exists(select 1 from public.assessments a where a.id=assessment_id and (a.published or public.is_admin())));
