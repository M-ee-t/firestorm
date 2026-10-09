-- FIRESTORM organizer admin backend
-- Review before running in Supabase SQL Editor.
-- Does not modify any existing player/game RPCs.
-- Provision admins manually after creating a non-anonymous Supabase Auth account.

begin;

create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'organizer' check (role = 'organizer'),
  created_at timestamptz not null default now()
);

alter table public.app_admins enable row level security;

-- No direct client access to the authorization table. SECURITY DEFINER
-- functions below perform the authorization check internally.
drop policy if exists "Admins can view their own record" on public.app_admins;
revoke all on table public.app_admins from public, anon, authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_admins a
    where a.user_id = auth.uid()
      and a.role = 'organizer'
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

create or replace function public.admin_get_games()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_games jsonb;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Unauthorized: organizer access required' using errcode = '42501';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', g.id,
        'name', g.name,
        'status', g.status,
        'demo_game', g.demo_game,
        'duration_seconds', g.duration_seconds,
        'started_at', g.started_at,
        'paused_at', g.paused_at,
        'total_paused_seconds', g.total_paused_seconds,
        'required_checkpoint_count', g.required_checkpoint_count,
        'created_at', g.created_at
      ) order by g.created_at desc
    ),
    '[]'::jsonb
  )
  into v_games
  from public.games g;

  return v_games;
end;
$$;

revoke all on function public.admin_get_games() from public, anon;
grant execute on function public.admin_get_games() to authenticated;

create or replace function public.admin_get_checkpoints(p_game_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_checkpoints jsonb;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Unauthorized: organizer access required' using errcode = '42501';
  end if;

  if p_game_id is null then
    raise exception 'Game ID is required' using errcode = '22023';
  end if;

  if not exists (select 1 from public.games g where g.id = p_game_id) then
    raise exception 'Game not found' using errcode = '22023';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', c.id,
        'game_id', c.game_id,
        'name', c.name,
        'latitude', c.latitude,
        'longitude', c.longitude,
        'radius_m', c.radius_m,
        'max_accuracy_m', c.max_accuracy_m,
        'order_index', c.order_index,
        'points_full', c.points_full,
        'points_late', c.points_late,
        'clue_text', c.clue_text,
        'hint_text', c.hint_text,
        'is_core', c.is_core,
        'active', c.active,
        'created_at', c.created_at,
        'updated_at', c.updated_at
      ) order by c.order_index asc, c.created_at asc
    ),
    '[]'::jsonb
  )
  into v_checkpoints
  from public.checkpoints c
  where c.game_id = p_game_id;

  return v_checkpoints;
end;
$$;

revoke all on function public.admin_get_checkpoints(uuid) from public, anon;
grant execute on function public.admin_get_checkpoints(uuid) to authenticated;

create or replace function public.admin_save_checkpoint(p_checkpoint jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_game_id uuid;
  v_name text;
  v_latitude double precision;
  v_longitude double precision;
  v_radius_m double precision;
  v_max_accuracy_m double precision;
  v_order_index integer;
  v_points_full integer;
  v_points_late integer;
  v_clue_text text;
  v_hint_text text;
  v_is_core boolean;
  v_active boolean;
  v_saved_id uuid;
  v_existing_core_id uuid;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Unauthorized: organizer access required' using errcode = '42501';
  end if;

  if p_checkpoint is null or jsonb_typeof(p_checkpoint) <> 'object' then
    raise exception 'Checkpoint payload must be a JSON object' using errcode = '22023';
  end if;

  -- Invalid UUID/numeric/boolean casts fail closed with a PostgreSQL input error.
  v_id := nullif(trim(p_checkpoint->>'id'), '')::uuid;
  v_game_id := nullif(trim(p_checkpoint->>'game_id'), '')::uuid;
  v_name := nullif(trim(p_checkpoint->>'name'), '');
  v_latitude := nullif(trim(p_checkpoint->>'latitude'), '')::double precision;
  v_longitude := nullif(trim(p_checkpoint->>'longitude'), '')::double precision;
  v_radius_m := nullif(trim(p_checkpoint->>'radius_m'), '')::double precision;
  v_max_accuracy_m := nullif(trim(p_checkpoint->>'max_accuracy_m'), '')::double precision;
  v_order_index := nullif(trim(p_checkpoint->>'order_index'), '')::integer;
  v_points_full := nullif(trim(p_checkpoint->>'points_full'), '')::integer;
  v_points_late := nullif(trim(p_checkpoint->>'points_late'), '')::integer;
  v_clue_text := nullif(trim(p_checkpoint->>'clue_text'), '');
  v_hint_text := nullif(trim(p_checkpoint->>'hint_text'), '');
  v_is_core := coalesce(nullif(trim(p_checkpoint->>'is_core'), '')::boolean, false);
  v_active := coalesce(nullif(trim(p_checkpoint->>'active'), '')::boolean, true);

  if v_game_id is null then raise exception 'Game ID is required' using errcode = '22023'; end if;
  if v_name is null or length(v_name) > 100 then
    raise exception 'Name is required and must be at most 100 characters' using errcode = '22023';
  end if;
  if v_latitude is null or v_latitude < -90 or v_latitude > 90 then
    raise exception 'Latitude must be between -90 and 90' using errcode = '22023';
  end if;
  if v_longitude is null or v_longitude < -180 or v_longitude > 180 then
    raise exception 'Longitude must be between -180 and 180' using errcode = '22023';
  end if;
  if v_radius_m is null or v_radius_m <= 0 or v_radius_m > 1000 then
    raise exception 'Radius must be greater than 0 and at most 1000 metres' using errcode = '22023';
  end if;
  if v_max_accuracy_m is null or v_max_accuracy_m <= 0 or v_max_accuracy_m > 200 then
    raise exception 'Maximum GPS accuracy must be greater than 0 and at most 200 metres' using errcode = '22023';
  end if;
  if v_order_index is null or v_order_index < 1 then
    raise exception 'Order must be at least 1' using errcode = '22023';
  end if;
  if v_points_full is null or v_points_full < 0 or v_points_late is null or v_points_late < 0 then
    raise exception 'Point values must be non-negative integers' using errcode = '22023';
  end if;
  if v_clue_text is null or length(v_clue_text) > 2000 then
    raise exception 'Clue is required and must be at most 2000 characters' using errcode = '22023';
  end if;
  if v_hint_text is not null and length(v_hint_text) > 1000 then
    raise exception 'Hint must be at most 1000 characters' using errcode = '22023';
  end if;

  -- Serialize admin changes per game to prevent concurrent edits bypassing
  -- the Core/order checks.
  perform 1 from public.games g where g.id = v_game_id for update;
  if not found then raise exception 'Game not found' using errcode = '22023'; end if;

  if v_id is not null and not exists (
    select 1 from public.checkpoints c where c.id = v_id and c.game_id = v_game_id
  ) then
    raise exception 'Checkpoint to edit was not found in this game' using errcode = '22023';
  end if;

  select c.id into v_existing_core_id
  from public.checkpoints c
  where c.game_id = v_game_id and c.is_core = true and c.active = true
    and (v_id is null or c.id <> v_id)
  order by c.created_at
  limit 1;

  -- A new active Core replaces the previous active Core atomically.
  -- The new Core must be later than every other active non-Core checkpoint.
  if v_is_core and v_active then
    if exists (
      select 1 from public.checkpoints c
      where c.game_id = v_game_id and c.active = true and c.is_core = false
        and c.order_index >= v_order_index
        and (v_id is null or c.id <> v_id)
    ) then
      raise exception 'Core must have a greater order than every active non-Core checkpoint' using errcode = '22023';
    end if;
  else
    -- Do not permit an operation to leave this game without an active Core.
    if v_existing_core_id is null and not (v_id is not null and exists (
      select 1 from public.checkpoints c
      where c.id = v_id and c.game_id = v_game_id and c.is_core = true and c.active = true
    )) then
      raise exception 'Keep one active Core checkpoint. Save a replacement Core first.' using errcode = '22023';
    end if;

    if v_active and exists (
      select 1 from public.checkpoints c
      where c.game_id = v_game_id and c.active = true and c.is_core = true
        and c.order_index <= v_order_index
        and (v_id is null or c.id <> v_id)
    ) then
      raise exception 'Non-Core checkpoints must be ordered before the active Core' using errcode = '22023';
    end if;
  end if;

  if v_id is not null then
    update public.checkpoints
    set name = v_name,
        latitude = v_latitude,
        longitude = v_longitude,
        radius_m = v_radius_m,
        max_accuracy_m = v_max_accuracy_m,
        order_index = v_order_index,
        points_full = v_points_full,
        points_late = v_points_late,
        clue_text = v_clue_text,
        hint_text = v_hint_text,
        is_core = v_is_core,
        active = v_active,
        updated_at = now()
    where id = v_id and game_id = v_game_id
    returning id into v_saved_id;
  else
    insert into public.checkpoints (
      game_id, name, latitude, longitude, radius_m, max_accuracy_m,
      order_index, points_full, points_late, clue_text, hint_text, is_core, active
    ) values (
      v_game_id, v_name, v_latitude, v_longitude, v_radius_m, v_max_accuracy_m,
      v_order_index, v_points_full, v_points_late, v_clue_text, v_hint_text, v_is_core, v_active
    )
    returning id into v_saved_id;
  end if;

  -- If the saved checkpoint is now the Core, demote the previous Core in the
  -- same transaction. Existing checkpoint history remains intact.
  if v_is_core and v_active and v_existing_core_id is not null then
    update public.checkpoints
    set is_core = false, updated_at = now()
    where id = v_existing_core_id and game_id = v_game_id;
  end if;

  -- Recheck final state after the atomic operation.
  if not exists (
    select 1 from public.checkpoints c
    where c.game_id = v_game_id and c.is_core = true and c.active = true
  ) then
    raise exception 'Game must have an active Core checkpoint' using errcode = '22023';
  end if;
  if (select count(*) from public.checkpoints c
      where c.game_id = v_game_id and c.is_core = true and c.active = true) <> 1 then
    raise exception 'Game must have exactly one active Core checkpoint' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.checkpoints core
    join public.checkpoints other on other.game_id = core.game_id
    where core.game_id = v_game_id and core.is_core = true and core.active = true
      and other.active = true and other.is_core = false
      and other.order_index >= core.order_index
  ) then
    raise exception 'All active non-Core checkpoints must be ordered before Core' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'success', true,
    'checkpoint_id', v_saved_id,
    'message', 'Checkpoint saved successfully'
  );
end;
$$;

revoke all on function public.admin_save_checkpoint(jsonb) from public, anon;
grant execute on function public.admin_save_checkpoint(jsonb) to authenticated;

commit;

-- After an organizer signs up with email/password, copy their UUID from
-- Supabase Dashboard > Authentication > Users, then run separately:
-- INSERT INTO public.app_admins (user_id, role)
-- VALUES ('<REAL-ORGANIZER-UUID>', 'organizer')
-- ON CONFLICT (user_id) DO NOTHING;
