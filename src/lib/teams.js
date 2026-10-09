import { supabase } from "./supabase";

export async function createTeam(gameId, teamName) {
  const { data, error } = await supabase.rpc("create_team", {
    p_game_id: gameId,
    p_team_name: teamName,
  });

  if (error) {
    throw error;
  }

  return data;
}

export async function joinTeam(gameId, teamCode) {
  const { data, error } = await supabase.rpc("join_team", {
    p_game_id: gameId,
    p_team_code: teamCode,
  });

  if (error) {
    throw error;
  }

  return data;
}

export async function getGameState() {
  const { data, error } = await supabase.rpc('get_game_state')

  if (error) {
    throw error
  }

  return data
}

export async function checkIn(latitude, longitude, accuracy) {
  const { data, error } = await supabase.rpc('check_in', {
    p_latitude: latitude,
    p_longitude: longitude,
    p_accuracy: accuracy,
  })

  if (error) {
    throw error
  }

  return data
}