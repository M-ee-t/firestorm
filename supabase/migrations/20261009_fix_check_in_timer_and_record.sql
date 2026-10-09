-- FIRESTORM migration: align check-in timer and update the exact check-in row.
-- Review before running in Supabase SQL Editor. This replaces the installed function.

BEGIN;

CREATE OR REPLACE FUNCTION public.check_in(p_latitude double precision, p_longitude double precision, p_accuracy double precision)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_team_id uuid;
  v_game_id uuid;
  v_game_status text;
  v_demo_game boolean;
  v_duration integer;
  v_started_at timestamptz;
  v_paused_at timestamptz;
  v_total_paused integer;
  v_extinguisher_seconds integer := 0;
  v_checkin_id uuid;
  v_checkpoint_id uuid;
  v_checkpoint_name text;
  v_radius_m double precision;
  v_max_accuracy_m double precision;
  v_points_full integer;
  v_points_late integer;
  v_is_core boolean;
  v_order_index integer;
  v_distance_m double precision;
  v_elapsed numeric;
  v_fire_percent numeric;
  v_points integer;
  v_next_checkpoint_id uuid;
  v_recent_attempts integer;
  v_finished_at timestamptz;
begin
  /*
    ----------------------------------------------------------
    1. Basic authentication / input validation
    ----------------------------------------------------------
  */
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if p_latitude is null
     or p_longitude is null
     or p_accuracy is null then
    raise exception 'Latitude, longitude and accuracy are required';
  end if;
  if p_latitude < -90
     or p_latitude > 90
     or p_longitude < -180
     or p_longitude > 180 then
    raise exception 'Invalid coordinates';
  end if;
  if p_accuracy <= 0 then
    raise exception 'Invalid GPS accuracy';
  end if;
  /*
    ----------------------------------------------------------
    2. Find the authenticated user's team
    ----------------------------------------------------------
  */
  select
    tm.team_id,
    tm.game_id
  into
    v_team_id,
    v_game_id
  from public.team_members tm
  where tm.user_id = v_user_id
  order by tm.created_at desc
  limit 1;
  if v_team_id is null then
    raise exception 'You are not a member of a team';
  end if;
  /*
    ----------------------------------------------------------
    3. Lock the team row
       This prevents two simultaneous check-ins from
       awarding the same checkpoint twice.
    ----------------------------------------------------------
  */
  perform 1
  from public.teams
  where id = v_team_id
  for update;
  /*
    ----------------------------------------------------------
    4. Get game information
    ----------------------------------------------------------
  */
  select
    g.status::text,
    g.demo_game,
    g.duration_seconds,
    g.started_at,
    g.paused_at,
    g.total_paused_seconds
  into
    v_game_status,
    v_demo_game,
    v_duration,
    v_started_at,
    v_paused_at,
    v_total_paused
  from public.games g
  where g.id = v_game_id;
  if not found then
    raise exception 'Game not found';
  end if;
  if v_game_status <> 'live' then
    raise exception 'Game is not live';
  end if;
  /*
    ----------------------------------------------------------
    5. Find the team's current checkpoint.
       The client never tells us which checkpoint it wants.
    ----------------------------------------------------------
  */
  select
    c.id,
    c.name,
    c.radius_m,
    c.max_accuracy_m,
    c.points_full,
    c.points_late,
    c.is_core,
    c.order_index
  into
    v_checkpoint_id,
    v_checkpoint_name,
    v_radius_m,
    v_max_accuracy_m,
    v_points_full,
    v_points_late,
    v_is_core,
    v_order_index
  from public.team_checkpoints tc
  join public.checkpoints c
    on c.id = tc.checkpoint_id
  where tc.team_id = v_team_id
    and tc.status = 'available'::public.team_checkpoint_status
    and c.active = true
  order by c.order_index
  limit 1;
  if v_checkpoint_id is null then
    raise exception 'No checkpoint is currently available';
  end if;
  /*
    ----------------------------------------------------------
    6. Calculate gameplay elapsed time
    ----------------------------------------------------------
  */
  if v_started_at is null then
    v_elapsed := 0;
  elsif v_paused_at is not null then
    v_elapsed :=
      extract(epoch from (v_paused_at - v_started_at))
      - coalesce(v_total_paused, 0);
  else
    v_elapsed :=
      extract(epoch from (now() - v_started_at))
      - coalesce(v_total_paused, 0);
  end if;
  v_elapsed := greatest(0, v_elapsed);

  -- Match get_game_state(): subtract time earned from used Extinguisher power-ups.
  select coalesce(sum(tp.extinguisher_seconds), 0)::integer
  into v_extinguisher_seconds
  from public.team_powerups tp
  where tp.team_id = v_team_id
    and tp.type::text = 'extinguisher';

  v_elapsed := greatest(
    0,
    v_elapsed - coalesce(v_extinguisher_seconds, 0)
  );

  /*
    ----------------------------------------------------------
    7. Calculate fire percentage
    ----------------------------------------------------------
  */
  if v_duration is null or v_duration <= 0 then
    v_fire_percent := 0;
  else
    v_fire_percent :=
      least(
        100,
        greatest(
          0,
          (v_elapsed / v_duration) * 100
        )
      );
  end if;
  /*
    ----------------------------------------------------------
    8. Stop the game if the fire has reached 100%.
    ----------------------------------------------------------
  */
  if v_fire_percent >= 100 then
    insert into public.checkins (
      team_id,
      checkpoint_id,
      latitude,
      longitude,
      accuracy,
      distance_m,
      verified
    )
    values (
      v_team_id,
      v_checkpoint_id,
      p_latitude,
      p_longitude,
      p_accuracy,
      null,
      false
    );
    return jsonb_build_object(
      'success', false,
      'reason', 'game_over',
      'fire_percent', 100
    );
  end if;
  /*
    ----------------------------------------------------------
    9. Rate limit
       Count ALL attempts in the last 60 seconds.
    ----------------------------------------------------------
  */
  select count(*)
  into v_recent_attempts
  from public.checkins
  where team_id = v_team_id
    and created_at >= now() - interval '60 seconds';
  if v_recent_attempts >= 5 then
    insert into public.checkins (
      team_id,
      checkpoint_id,
      latitude,
      longitude,
      accuracy,
      distance_m,
      verified
    )
    values (
      v_team_id,
      v_checkpoint_id,
      p_latitude,
      p_longitude,
      p_accuracy,
      null,
      false
    );
    return jsonb_build_object(
      'success', false,
      'reason', 'rate_limited'
    );
  end if;
  /*
    ----------------------------------------------------------
    10. Calculate Haversine distance.
        Earth radius ≈ 6,371,000 metres.
    ----------------------------------------------------------
  */
  v_distance_m :=
    2 * 6371000 *
    asin(
      sqrt(
        power(
          sin(
            radians(
              c.latitude - p_latitude
            ) / 2
          ),
          2
        )
        +
        cos(radians(p_latitude))
        *
        cos(radians(c.latitude))
        *
        power(
          sin(
            radians(
              c.longitude - p_longitude
            ) / 2
          ),
          2
        )
      )
    )
  from public.checkpoints c
  where c.id = v_checkpoint_id;
  /*
    ----------------------------------------------------------
    11. Record the attempt.
        It starts as unverified.
    ----------------------------------------------------------
  */
  insert into public.checkins (
    team_id,
    checkpoint_id,
    latitude,
    longitude,
    accuracy,
    distance_m,
    verified
  )
  values (
    v_team_id,
    v_checkpoint_id,
    p_latitude,
    p_longitude,
    p_accuracy,
    v_distance_m,
    false
  )
  returning id into v_checkin_id;
  /*
    ----------------------------------------------------------
    12. Verify GPS accuracy and geofence.
    ----------------------------------------------------------
  */
  if p_accuracy > v_max_accuracy_m then
    return jsonb_build_object(
      'success', false,
      'reason', 'poor_accuracy',
      'message', 'GPS accuracy is not good enough. Move to an open area and try again.'
    );
  end if;
  if v_distance_m > v_radius_m then
    return jsonb_build_object(
      'success', false,
      'reason', 'outside_zone',
      'message', 'You are not inside the checkpoint zone yet.'
    );
  end if;
  /*
    ----------------------------------------------------------
    13. Mark this check-in verified.
    ----------------------------------------------------------
  */
  update public.checkins
  set verified = true
  where id = v_checkin_id;
  /*
    ----------------------------------------------------------
    14. Determine points.
        For MVP:
        - normal stage → points_full
        - final 25% of fire → points_late
    ----------------------------------------------------------
  */
  if v_fire_percent >= 75 then
    v_points := v_points_late;
  else
    v_points := v_points_full;
  end if;
  /*
    ----------------------------------------------------------
    15. Mark checkpoint verified.
    ----------------------------------------------------------
  */
  update public.team_checkpoints
  set
    status = 'verified'::public.team_checkpoint_status,
    verified_at = now(),
    points_awarded = v_points
  where team_id = v_team_id
    and checkpoint_id = v_checkpoint_id
    and status = 'available'::public.team_checkpoint_status;
  /*
    ----------------------------------------------------------
    16. Award points.
    ----------------------------------------------------------
  */
  update public.teams
  set
    score = score + v_points,
    updated_at = now()
  where id = v_team_id;
  /*
    ----------------------------------------------------------
    17. Core completion.
    ----------------------------------------------------------
  */
  if v_is_core then
    v_finished_at := now();
    update public.teams
    set finished_at = v_finished_at
    where id = v_team_id;
    update public.leaderboard
    set
      score = (
        select score
        from public.teams
        where id = v_team_id
      ),
      finished_at = v_finished_at,
      updated_at = now()
    where team_id = v_team_id;
    return jsonb_build_object(
      'success', true,
      'completed', true,
      'checkpoint', v_checkpoint_name,
      'points_awarded', v_points,
      'fire_percent', round(v_fire_percent, 1)
    );
  end if;
  /*
    ----------------------------------------------------------
    18. Find next checkpoint.
    ----------------------------------------------------------
  */
  select c.id
  into v_next_checkpoint_id
  from public.checkpoints c
  where c.game_id = v_game_id
    and c.active = true
    and c.is_core = false
    and c.order_index > v_order_index
    and not exists (
      select 1
      from public.team_checkpoints tc2
      where tc2.team_id = v_team_id
        and tc2.checkpoint_id = c.id
        and tc2.status = 'verified'::public.team_checkpoint_status
    )
  order by c.order_index
  limit 1;
  /*
    ----------------------------------------------------------
    19. If the required number of normal checkpoints has
        been completed, unlock the Core.
    ----------------------------------------------------------
  */
  if (
    select count(*)
    from public.team_checkpoints tc3
    join public.checkpoints c3
      on c3.id = tc3.checkpoint_id
    where tc3.team_id = v_team_id
      and tc3.status = 'verified'::public.team_checkpoint_status
      and c3.is_core = false
  ) >= (
    select required_checkpoint_count
    from public.games
    where id = v_game_id
  ) then
    select c.id
    into v_next_checkpoint_id
    from public.checkpoints c
    where c.game_id = v_game_id
      and c.active = true
      and c.is_core = true
    order by c.order_index
    limit 1;
  end if;
  /*
    ----------------------------------------------------------
    20. Unlock the next checkpoint.
    ----------------------------------------------------------
  */
  if v_next_checkpoint_id is not null then
    insert into public.team_checkpoints (
      team_id,
      checkpoint_id,
      status,
      points_awarded
    )
    values (
      v_team_id,
      v_next_checkpoint_id,
      'available'::public.team_checkpoint_status,
      0
    )
    on conflict (team_id, checkpoint_id)
    do nothing;
  end if;
  /*
    ----------------------------------------------------------
    21. Update leaderboard.
    ----------------------------------------------------------
  */
  update public.leaderboard
  set
    score = (
      select score
      from public.teams
      where id = v_team_id
    ),
    updated_at = now()
  where team_id = v_team_id;
  /*
    ----------------------------------------------------------
    22. Return safe result.
    ----------------------------------------------------------
  */
  return jsonb_build_object(
    'success', true,
    'completed', false,
    'checkpoint', v_checkpoint_name,
    'points_awarded', v_points,
    'fire_percent', round(v_fire_percent, 1)
  );
end;
$function$;

COMMIT;
