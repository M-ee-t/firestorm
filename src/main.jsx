import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './leaflet-icons'
import './styles.css'
import 'leaflet/dist/leaflet.css'
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  useMapEvents,
} from 'react-leaflet'
import { signInAnonymously } from './lib/auth'
import {
  createTeam,
  joinTeam,
  getGameState,
  checkIn,
} from './lib/teams'
import { supabase } from './lib/supabase'
import { AdminApp } from './AdminApp'

const DEMO_GAME_ID = 'dad9d436-36ad-401f-b152-507282420483'
const LIVE_GAME_ID = import.meta.env.VITE_LIVE_GAME_ID || ''
const MAX_GPS_FIX_AGE_MS = 15_000
const IET_CENTER_LAT = 22.6811
const IET_CENTER_LNG = 75.8805

function isFreshGpsFix(location, now = Date.now()) {
  if (
    !location ||
    !Number.isFinite(location.latitude) ||
    location.latitude < -90 ||
    location.latitude > 90 ||
    !Number.isFinite(location.longitude) ||
    location.longitude < -180 ||
    location.longitude > 180 ||
    !Number.isFinite(location.accuracy) ||
    location.accuracy <= 0 ||
    !Number.isFinite(location.positionTimestamp)
  ) {
    return false
  }

  const ageMs = now - location.positionTimestamp
  return ageMs >= 0 && ageMs <= MAX_GPS_FIX_AGE_MS
}

/*
  ----------------------------------------------------------
  GPS LOCATION HOOK
  ----------------------------------------------------------
*/
function usePlayerLocation() {
  const [location, setLocation] = useState(null)
  const [gpsError, setGpsError] = useState('')
  const [gpsStatus, setGpsStatus] = useState('GPS not started')

  useEffect(() => {
    if (!navigator.geolocation) {
      setLocation(null)
      setGpsError('Geolocation is not supported by this browser.')
      setGpsStatus('GPS unavailable')
      return
    }

    setGpsStatus('Requesting GPS permission...')

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords
        setLocation({
          latitude,
          longitude,
          accuracy,
          positionTimestamp: position.timestamp,
        })
        setGpsError('')
        setGpsStatus('GPS active')
      },
      (error) => {
        console.error('GPS ERROR:', error)
        setLocation(null)
        if (error.code === error.PERMISSION_DENIED) {
          setGpsError(
            'Location permission was denied. Please allow location access.'
          )
        } else if (error.code === error.POSITION_UNAVAILABLE) {
          setGpsError(
            'Your device could not determine its location.'
          )
        } else if (error.code === error.TIMEOUT) {
          setGpsError(
            'GPS took too long to respond. Trying again...'
          )
        } else {
          setGpsError('Unable to get your location.')
        }
        setGpsStatus('GPS error')
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 10000,
      }
    )

    return () => {
      navigator.geolocation.clearWatch(watchId)
    }
  }, [])

  return {
    location,
    gpsError,
    gpsStatus,
  }
}

/*
  ----------------------------------------------------------
  MAP CAMERA FOLLOWER & CLICK HANDLER
  ----------------------------------------------------------
*/
function MapClickHandler({ onSelect }) {
  useMapEvents({
    click(event) {
      if (onSelect) {
        onSelect({
          latitude: event.latlng.lat,
          longitude: event.latlng.lng,
          accuracy: 10,
        })
      }
    },
  })
  return null
}

function FirestormMap({ location, simulatedLocation, onSimulatedLocation }) {
  return (
    <div style={{ height: '100%', width: '100%' }}>
      <MapContainer
        center={[IET_CENTER_LAT, IET_CENTER_LNG]}
        zoom={18}
        scrollWheelZoom={true}
        style={{
          height: '100%',
          width: '100%',
        }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {onSimulatedLocation && <MapClickHandler onSelect={onSimulatedLocation} />}
        {location && (
          <Marker position={[location.latitude, location.longitude]}>
            <Popup>
              <strong>Your location</strong>
              <br />
              Accuracy: {Math.round(location.accuracy)} m
            </Popup>
          </Marker>
        )}
        {simulatedLocation && (
          <Marker
            position={[
              simulatedLocation.latitude,
              simulatedLocation.longitude,
            ]}
          >
            <Popup>
              <strong>Demo pin</strong>
              <br />
              This pin will be used for check-in.
            </Popup>
          </Marker>
        )}
      </MapContainer>
    </div>
  )
}

function App() {
  const [user, setUser] = useState(null)
  const [team, setTeam] = useState(null)
  const [gameState, setGameState] = useState(null)
  const [checkInResult, setCheckInResult] = useState(null)
  const [simulatedLocation, setSimulatedLocation] = useState(null)

  const [extinguisherLoading, setExtinguisherLoading] = useState(false)
  const [extinguisherMessage, setExtinguisherMessage] = useState('')

  const [hintLoading, setHintLoading] = useState(false)
  const [hintMessage, setHintMessage] = useState('')

  const [widerZoneLoading, setWiderZoneLoading] = useState(false)
  const [widerZoneMessage, setWiderZoneMessage] = useState('')

  const [leaderboard, setLeaderboard] = useState([])
  const [leaderboardError, setLeaderboardError] = useState('')

  const [teamName, setTeamName] = useState('')
  const [teamCode, setTeamCode] = useState('')
  const [selectedGameId, setSelectedGameId] = useState(DEMO_GAME_ID)
  const [status, setStatus] = useState('Not connected')
  const [error, setError] = useState('')
  const [showSwitchSquad, setShowSwitchSquad] = useState(false)

  const { location, gpsError, gpsStatus } = usePlayerLocation()

  // Game ID is selected explicitly during setup and confirmed by server state.
  const activeGameId = team?.game_id || null

  // Player check-ins always use browser GPS; map-tap simulation is disabled.
  const demoSimulationAllowed = false

  function handleMapSimulationClick(location) {
    if (
      selectedGameId !== DEMO_GAME_ID ||
      team?.game_id !== DEMO_GAME_ID ||
      gameState?.demo_game !== true ||
      gameState?.game_id !== DEMO_GAME_ID
    ) {
      return
    }
    setSimulatedLocation(location)
  }

  async function fetchLeaderboard() {
    try {
      if (!activeGameId) return
      setLeaderboardError('')
      const { data, error: leaderboardError } = await supabase
        .from('leaderboard')
        .select('team_name, score, finished_at, updated_at')
        .eq('game_id', activeGameId)
        .order('score', { ascending: false })

      if (leaderboardError) throw leaderboardError

      const sorted = [...(data || [])].sort((a, b) => {
        const scoreDiff = Number(b.score || 0) - Number(a.score || 0)
        if (scoreDiff !== 0) return scoreDiff
        if (a.finished_at && b.finished_at) {
          return new Date(a.finished_at) - new Date(b.finished_at)
        }
        if (a.finished_at) return -1
        if (b.finished_at) return 1
        return 0
      })

      setLeaderboard(sorted)
    } catch (err) {
      console.error('LEADERBOARD:', err)
      setLeaderboardError(err.message)
    }
  }

  async function handleSignIn() {
    try {
      setError('')
      setStatus('Signing in...')
      const authenticatedUser = await signInAnonymously()
      setUser(authenticatedUser)
      setStatus('Authenticated')
    } catch (err) {
      console.error(err)
      setError(err.message)
      setStatus('Authentication failed')
    }
  }

  async function handleCreateTeam() {
    try {
      setError('')
      if (!user) {
        throw new Error('Sign in first.')
      }
      if (!teamName.trim()) {
        throw new Error('Enter a team name.')
      }
      setStatus('Creating team...')
      if (!selectedGameId) throw new Error('Select a configured game first.')
      const result = await createTeam(selectedGameId, teamName.trim())
      if (result?.game_id && result.game_id !== selectedGameId) {
        throw new Error('The server returned a different game than the one selected.')
      }
      setGameState(null)
      setSimulatedLocation(null)
      setTeam({ ...result, game_id: result.game_id || selectedGameId })
      setStatus('Team created!')
      setShowSwitchSquad(false)
    } catch (err) {
      console.error(err)
      setError(err.message)
      setStatus('Could not create team')
    }
  }

  async function handleJoinTeam() {
    try {
      setError('')
      if (!user) {
        throw new Error('Sign in first.')
      }
      if (!teamCode.trim()) {
        throw new Error('Enter a team code.')
      }
      setStatus('Joining team...')
      if (!selectedGameId) throw new Error('Select a configured game first.')
      const result = await joinTeam(selectedGameId, teamCode.trim().toUpperCase())
      if (result?.game_id && result.game_id !== selectedGameId) {
        throw new Error('The server returned a different game than the one selected.')
      }
      setGameState(null)
      setSimulatedLocation(null)
      setTeam({ ...result, game_id: result.game_id || selectedGameId })
      setStatus('Joined team!')
      setShowSwitchSquad(false)
    } catch (err) {
      console.error(err)
      setError(err.message)
      setStatus('Could not join team')
    }
  }

  async function handleGetGameState() {
    try {
      setError('')
      if (!user) {
        throw new Error('Sign in first.')
      }
      if (!team) {
        throw new Error('Create or join a team first.')
      }
      setStatus('Fetching secure game state...')
      const state = await getGameState()
      if (state?.game_id !== team.game_id) {
        throw new Error('The server game state does not match the selected game.')
      }
      setGameState(state)
      setStatus('Game state received!')
    } catch (err) {
      console.error(err)
      setError(err.message)
      setStatus('Could not fetch game state')
    }
  }

  async function handleUseExtinguisher() {
    try {
      setError('')
      setExtinguisherMessage('')
      if (!team) {
        throw new Error('Create or join a team first.')
      }
      setExtinguisherLoading(true)
      const { data: result, error: rpcError } = await supabase.rpc('use_extinguisher')

      if (rpcError) {
        throw rpcError
      }

      if (!result.success) {
        setExtinguisherMessage(
          result.reason === 'no_extinguisher'
            ? 'No Extinguisher remaining.'
            : 'Extinguisher could not be used.'
        )
        return
      }

      setExtinguisherMessage(
        `Extinguisher used: +${Math.round(result.seconds_added / 60)} min added.`
      )
      const updatedState = await getGameState()
      setGameState(updatedState)
    } catch (err) {
      console.error('EXTINGUISHER:', err)
      setError(err.message)
    } finally {
      setExtinguisherLoading(false)
    }
  }

  async function handleUseHint() {
    try {
      setError('')
      setHintMessage('')
      if (!team) {
        throw new Error('Create or join a team first.')
      }
      setHintLoading(true)
      const { data: result, error: rpcError } = await supabase.rpc('use_hint')

      if (rpcError) {
        throw rpcError
      }

      if (!result.success) {
        if (result.reason === 'insufficient_points') {
          setHintMessage(
            `Need ${result.required_points} points. You have ${result.current_score}.`
          )
        } else if (result.reason === 'no_hint') {
          setHintMessage('No Hint remaining.')
        } else if (result.reason === 'no_active_checkpoint') {
          setHintMessage('There is no active checkpoint.')
        } else {
          setHintMessage('Hint could not be used.')
        }
        return
      }

      setHintMessage(`Hint: ${result.hint_text}`)
      const updatedState = await getGameState()
      setGameState(updatedState)
    } catch (err) {
      console.error('HINT:', err)
      setError(err.message)
    } finally {
      setHintLoading(false)
    }
  }

  async function handleUseWiderZone() {
    try {
      setError('')
      setWiderZoneMessage('')

      if (!team) {
        throw new Error('Create or join a team first.')
      }

      setWiderZoneLoading(true)

      const { data: result, error: rpcError } = await supabase.rpc('use_wider_zone')

      if (rpcError) {
        throw rpcError
      }

      if (!result.success) {
        if (result.reason === 'no_wider_zone') {
          setWiderZoneMessage('No Wider Zone remaining.')
        } else if (result.reason === 'no_active_checkpoint') {
          setWiderZoneMessage('There is no active checkpoint.')
        } else {
          setWiderZoneMessage('Wider Zone could not be used.')
        }
        return
      }

      const multiplier = Number(result.zone_multiplier || 1.5)
      setWiderZoneMessage(
        `Wider Zone active: ${multiplier}× radius for next checkpoint.`
      )

      const updatedState = await getGameState()
      setGameState(updatedState)
    } catch (err) {
      console.error('WIDER ZONE:', err)
      setError(err.message)
    } finally {
      setWiderZoneLoading(false)
    }
  }

  async function handleCheckIn() {
    try {
      setError('')
      setCheckInResult(null)
      if (!user) {
        throw new Error('Sign in first.')
      }
      if (!team) {
        throw new Error('Create or join a team first.')
      }

      if (
        selectedGameId !== team.game_id ||
        !gameState?.game_id ||
        !activeGameId ||
        gameState.game_id !== team.game_id
      ) {
        throw new Error('Game state is still loading. Please wait before checking in.')
      }
      const canSimulate = demoSimulationAllowed
      // Demo pin is used only for the designated UUID when the server confirms
      // demo_game=true. Every other check-in uses browser GPS.
      const checkInLocation = canSimulate && simulatedLocation
        ? simulatedLocation
        : location

      if (!canSimulate) {
        if (gpsError) {
          throw new Error(`${gpsError} A new successful GPS reading is required before check-in.`)
        }
        if (!isFreshGpsFix(location)) {
          throw new Error(
            location
              ? 'Your GPS reading is older than 15 seconds. Waiting for a fresh location before check-in.'
              : 'Waiting for a new successful GPS reading before check-in.'
          )
        }
      }

      if (!checkInLocation) {
        throw new Error(
          canSimulate
            ? 'Waiting for GPS location, or click the map to place a demo pin.'
            : 'Waiting for device GPS location...'
        )
      }

      setStatus(
        canSimulate && simulatedLocation
          ? 'Checking demo pin location...'
          : 'Checking device GPS location...'
      )

      const result = await checkIn(
        checkInLocation.latitude,
        checkInLocation.longitude,
        checkInLocation.accuracy
      )

      console.log(
        canSimulate && simulatedLocation ? 'DEMO CHECK-IN:' : 'REAL GPS CHECK-IN:',
        result
      )

      setCheckInResult(result)
      if (result.success) {
        setStatus('Checkpoint verified')
      } else {
        setStatus(`Check-in rejected: ${result.reason || 'unknown reason'}`)
      }

      const updatedState = await getGameState()
      setGameState(updatedState)
    } catch (err) {
      console.error(err)
      setError(err.message)
      setStatus('Check-in failed')
    }
  }

  // LEADERBOARD REFRESH
  useEffect(() => {
    if (!team) return
    fetchLeaderboard()
    const intervalId = setInterval(fetchLeaderboard, 5000)
    return () => clearInterval(intervalId)
  }, [team])

  // Keep fire percentage and checkpoint state synced with the server.
  useEffect(() => {
    if (!team) return
    let cancelled = false

    async function refreshGameStateSilently() {
      try {
        const state = await getGameState()
        if (!cancelled && state?.game_id === team.game_id) {
          setGameState(state)
        }
      } catch (err) {
        console.error('GAME STATE REFRESH:', err)
      }
    }

    refreshGameStateSilently()
    const intervalId = setInterval(refreshGameStateSilently, 5000)
    return () => {
      cancelled = true
      clearInterval(intervalId)
    }
  }, [team])

  // Computed values
  const firePercent = gameState
    ? Math.min(100, Math.max(0, Number(gameState.fire_percent) || 0))
    : 0

  const activeCheckpoint = gameState?.current_checkpoint
  const isFinished =
    gameState?.game_status === 'finished' ||
    Boolean(gameState?.finished_at) ||
    (!activeCheckpoint && gameState && Number(gameState.fire_percent) < 100 && Number(gameState.score || 0) > 0)

  // Timer calculation
  const timerDisplay = (() => {
    if (!gameState) return null
    const secs =
      typeof gameState.time_remaining === 'number'
        ? gameState.time_remaining
        : typeof gameState.seconds_remaining === 'number'
          ? gameState.seconds_remaining
          : typeof gameState.time_remaining_seconds === 'number'
            ? gameState.time_remaining_seconds
            : null
    if (secs !== null) {
      const m = Math.floor(Math.max(0, secs) / 60)
      const s = Math.floor(Math.max(0, secs) % 60)
      return `${m}:${s.toString().padStart(2, '0')}`
    }
    if (gameState.expires_at) {
      const diff = Math.max(0, Math.floor((new Date(gameState.expires_at).getTime() - Date.now()) / 1000))
      const m = Math.floor(diff / 60)
      const s = Math.floor(diff % 60)
      return `${m}:${s.toString().padStart(2, '0')}`
    }
    if (gameState.extinguisher_seconds) {
      return `+${Math.round(Number(gameState.extinguisher_seconds) / 60)}M BUFFER`
    }
    return null
  })()

  // Completed ranking and time
  const myRankIndex = leaderboard.findIndex((e) => e.team_name === team?.team_name)
  const myRank = myRankIndex !== -1 ? `#${myRankIndex + 1}` : '#1'
  const myEntry = myRankIndex !== -1 ? leaderboard[myRankIndex] : null
  const finishedTimestamp = gameState?.finished_at || myEntry?.finished_at
  const formattedCompletionTime = finishedTimestamp
    ? new Date(finishedTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'Verified'

  // GPS indicator text
  const gpsIndicatorText = (() => {
    if (demoSimulationAllowed && simulatedLocation) {
      return `DEMO PIN · ±10 M`
    }
    if (location) {
      return `GPS ACTIVE · ±${Math.round(location.accuracy)} M`
    }
    if (gpsError) {
      return 'LOCATION UNAVAILABLE'
    }
    return 'WAITING FOR LOCATION...'
  })()

  return (
    <div className="app-container">
      {/* BRANDING */}
      <header className="brand-header">
        <h1 className="brand-title">FIRESTORM</h1>
        <p className="brand-subtitle">The fire is spreading. Reach the Core.</p>
      </header>

      {/* ERROR BANNER */}
      {error && (
        <div className="error-banner">
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* 2. FIRE LEVEL HUD */}
      <section className="fire-hud-card">
        <div className="fire-hud-pct">{firePercent}%</div>
        <div className="fire-hud-label">FIRE LEVEL</div>
        <div className="fire-hud-track">
          <div
            className="fire-hud-fill"
            style={{ width: `${firePercent}%` }}
          />
        </div>
        <div className="fire-hud-footer">
          <span className="fire-hud-status">
            {gameState?.game_status === 'live'
              ? 'LIVE'
              : (gameState?.game_status || 'WAITING').toUpperCase()}
          </span>
          <span className="fire-hud-timer">
            {timerDisplay || `${gameState ? Number(gameState.score || 0) : 0} PTS`}
          </span>
        </div>
      </section>

      {/* SQUAD STATUS (WHEN CONNECTED) */}
      {team && (
        <div className="team-status-bar">
          <div>
            Squad: <strong>{team.team_name}</strong>
            {team.team_code && (
              <span style={{ marginLeft: '8px' }}>
                <code>{team.team_code}</code>
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span><strong>{gameState ? Number(gameState.score || 0) : 0}</strong> pts</span>
            <button
              className="btn-switch-squad"
              onClick={() => setShowSwitchSquad(!showSwitchSquad)}
            >
              {showSwitchSquad ? 'Cancel' : 'Change'}
            </button>
          </div>
        </div>
      )}

      {/* AUTHENTICATION (IF NOT LOGGED IN) */}
      {!user && (
        <section className="setup-card">
          <div className="section-eyebrow">AUTHENTICATION</div>
          <p className="setup-desc">
            Sign in anonymously to join the event and record your check-ins.
          </p>
          <button className="btn-secondary" onClick={handleSignIn}>
            Sign in anonymously
          </button>
          <div className="setup-status">Status: {status}</div>
        </section>
      )}

      {/* SQUAD SETUP (IF NO TEAM OR SWITCHING) */}
      {(!team || showSwitchSquad) && user && (
        <section className="setup-card">
          <div className="section-eyebrow">
            {team ? 'CHANGE SQUAD' : 'SQUAD SETUP'}
          </div>
          <p className="setup-desc">
            Create a squad for your team or enter a 4-letter code from a teammate.
          </p>
          <div className="setup-form-group">
            <label htmlFor="game-choice">Game</label>
            <select id="game-choice" className="text-input" value={selectedGameId} onChange={(e) => { setSelectedGameId(e.target.value); setSimulatedLocation(null) }}>
              <option value={DEMO_GAME_ID}>Demo game</option>
              {LIVE_GAME_ID && <option value={LIVE_GAME_ID}>Live game</option>}
            </select>
            {!LIVE_GAME_ID && <small>No live game is configured. Set VITE_LIVE_GAME_ID to the organizer-provided game UUID.</small>}
          </div>
          <div className="setup-forms">
            <div className="setup-form-group">
              <label>Create squad</label>
              <div className="input-with-button">
                <input
                  className="text-input"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="Squad name"
                />
                <button className="btn-secondary" onClick={handleCreateTeam}>
                  Create
                </button>
              </div>
            </div>

            <div className="setup-form-group">
              <label>Join squad</label>
              <div className="input-with-button">
                <input
                  className="text-input code-input"
                  value={teamCode}
                  onChange={(e) => setTeamCode(e.target.value.toUpperCase())}
                  placeholder="ABCD"
                  maxLength={4}
                />
                <button className="btn-secondary" onClick={handleJoinTeam}>
                  Join
                </button>
              </div>
            </div>
          </div>
          <div className="setup-status">Status: {status}</div>
        </section>
      )}

      {/* 8. COMPLETED / CORE REACHED STATE */}
      {team && isFinished ? (
        <section className="objective-card completed-card">
          <div className="section-eyebrow">CORE REACHED</div>
          <h2 className="completed-title">{team.team_name}</h2>
          <div className="completed-score">
            {gameState ? Number(gameState.score || 0) : 0} POINTS
          </div>
          <div className="completed-meta">
            ROUTE COMPLETE
            <span className="completed-sub">{myRank} · {formattedCompletionTime}</span>
          </div>
        </section>
      ) : (
        /* 3 & 4. CURRENT OBJECTIVE & CHECK IN */
        <section className="objective-card">
          <div className="section-eyebrow">CURRENT OBJECTIVE</div>

          {activeCheckpoint ? (
            <>
              <h2 className="objective-name">
                {activeCheckpoint.name}
                {activeCheckpoint.is_core && (
                  <span className="core-tag">CORE</span>
                )}
              </h2>
              <div className="objective-clue">
                {activeCheckpoint.clue}
              </div>
            </>
          ) : (
            <div style={{ marginBottom: '14px' }}>
              <h2 className="objective-name" style={{ color: 'var(--text-muted)' }}>
                {team ? 'Awaiting checkpoint' : 'Join a squad to receive checkpoint'}
              </h2>
              <p style={{ color: 'var(--text-dim)', fontSize: '13px' }}>
                {team
                  ? 'Check in to verify your position or wait for route coordinates.'
                  : 'Create or join a squad above to receive your initial objective.'}
              </p>
            </div>
          )}

          {/* CHECK IN BUTTON */}
          <button
            className="btn-checkin"
            onClick={handleCheckIn}
            disabled={
              !team ||
              selectedGameId !== team.game_id ||
              !gameState?.game_id ||
              gameState.game_id !== team.game_id ||
              (!demoSimulationAllowed && (gpsError || !isFreshGpsFix(location))) ||
              (demoSimulationAllowed && !location && !simulatedLocation)
            }
          >
            CHECK IN
          </button>

          {/* GPS INDICATOR */}
          <div className="gps-status-indicator">
            {gpsIndicatorText}
          </div>
          {team && !demoSimulationAllowed && gpsError && (
            <div style={{ color: 'var(--color-error-text)', fontSize: '12px', marginTop: '6px' }}>
              {gpsError} A new successful GPS reading is required before live check-in.
            </div>
          )}

          {/* CHECK IN RESULT */}
          {checkInResult && (
            <div
              className={`checkin-result ${
                checkInResult.success ? 'success' : 'rejected'
              }`}
            >
              <strong>
                {checkInResult.success
                  ? 'Checkpoint verified'
                  : 'Check-in rejected'}
              </strong>
              {checkInResult.checkpoint && (
                <div className="result-detail">
                  Checkpoint: {checkInResult.checkpoint}
                </div>
              )}
              {checkInResult.points_awarded !== undefined && (
                <div className="result-detail">
                  Points awarded: +{checkInResult.points_awarded}
                </div>
              )}
              {checkInResult.distance_m !== undefined && (
                <div className="result-detail">
                  Distance: {checkInResult.distance_m} m
                </div>
              )}
              {checkInResult.reason && (
                <div className="result-detail">
                  Reason: {checkInResult.reason}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* 5. POWER-UPS */}
      <section className="powerups-card">
        <div className="section-eyebrow">POWER-UPS</div>
        <div className="powerups-grid">
          <div className="powerup-box">
            <span className="powerup-title">Extinguisher</span>
            <span className="powerup-desc">+3 min fire buffer</span>
            <button
              className="btn-powerup"
              onClick={handleUseExtinguisher}
              disabled={
                !team ||
                extinguisherLoading ||
                gameState?.game_status !== 'live'
              }
            >
              {extinguisherLoading ? 'Using...' : 'Use'}
            </button>
          </div>

          <div className="powerup-box">
            <span className="powerup-title">Hint</span>
            <span className="powerup-desc">Costs 25 points</span>
            <button
              className="btn-powerup"
              onClick={handleUseHint}
              disabled={
                !team ||
                hintLoading ||
                gameState?.game_status !== 'live' ||
                Number(gameState?.score || 0) < 25
              }
            >
              {hintLoading ? 'Loading...' : 'Use'}
            </button>
          </div>

          <div className="powerup-box">
            <span className="powerup-title">Wider Zone</span>
            <span className="powerup-desc">1.5× radius</span>
            <button
              className="btn-powerup"
              onClick={handleUseWiderZone}
              disabled={
                !team ||
                widerZoneLoading ||
                gameState?.game_status !== 'live'
              }
            >
              {widerZoneLoading ? 'Using...' : 'Use'}
            </button>
          </div>
        </div>

        {extinguisherMessage && (
          <div className="powerup-msg" style={{ color: 'var(--color-success-text)' }}>
            {extinguisherMessage}
          </div>
        )}
        {hintMessage && (
          <div className="powerup-msg hint">
            {hintMessage}
          </div>
        )}
        {widerZoneMessage && (
          <div className="powerup-msg" style={{ color: 'var(--color-success-text)' }}>
            {widerZoneMessage}
          </div>
        )}
      </section>

      {/* 6. CAMPUS MAP */}
      <section className="map-card">
        <div className="map-header-row">
          <span className="section-eyebrow">CAMPUS MAP</span>
          {demoSimulationAllowed && simulatedLocation && (
            <button
              className="btn-link"
              onClick={() => {
                if (demoSimulationAllowed) setSimulatedLocation(null)
              }}
            >
              Clear demo pin
            </button>
          )}
        </div>

        <div className="map-frame">
          <FirestormMap
            location={location}
            simulatedLocation={demoSimulationAllowed ? simulatedLocation : null}
            onSimulatedLocation={demoSimulationAllowed ? handleMapSimulationClick : null}
          />
        </div>

        {demoSimulationAllowed && (
          <div className="map-demo-hint">
            Demo mode: Click anywhere on map to set simulated check-in location.
          </div>
        )}
      </section>

      {/* 7. LEADERBOARD */}
      {team && (
        <section className="leaderboard-card">
          <div className="section-eyebrow">LEADERBOARD</div>
          <div className="section-caption">
            Highest score wins. Ties are broken by earliest Core arrival.
          </div>

          {leaderboardError && (
            <div style={{ color: 'var(--color-error-text)', fontSize: '12px', margin: '6px 0' }}>
              Could not load leaderboard: {leaderboardError}
            </div>
          )}

          {leaderboard.length > 0 ? (
            <div className="leaderboard-list">
              {leaderboard.map((entry, index) => {
                const isCurrentTeam = entry.team_name === team?.team_name
                const rankNum = (index + 1).toString().padStart(2, '0')
                return (
                  <div
                    key={`${entry.team_name}-${index}`}
                    className={`leaderboard-row ${isCurrentTeam ? 'current-team' : ''}`}
                  >
                    <span className="lb-rank">{rankNum}</span>
                    <span className="lb-name">
                      {entry.team_name}
                      {isCurrentTeam && <span className="lb-you">(You)</span>}
                    </span>
                    <span className="lb-score">
                      {Number(entry.score || 0)} pts
                    </span>
                  </div>
                )
              })}
            </div>
          ) : (
            !leaderboardError && (
              <div style={{ color: 'var(--text-dim)', fontSize: '12px' }}>
                No teams registered yet.
              </div>
            )
          )}
        </section>
      )}

      {/* DEVELOPER TEST CONTROLS (ONLY IN DEMO MODE) */}
      {demoSimulationAllowed && (
        <details className="dev-details">
          <summary className="dev-summary">Developer test controls</summary>
          <div className="dev-content">
            <div>
              <strong>Game state:</strong>
              <div style={{ marginTop: '4px' }}>
                <button
                  className="dev-btn"
                  onClick={handleGetGameState}
                  disabled={!team}
                >
                  Get game state
                </button>
              </div>
            </div>

            <div>
              <strong>User ID:</strong> {user ? user.id : 'Not signed in'}
              <div style={{ marginTop: '4px' }}>
                <button className="dev-btn" onClick={handleSignIn}>
                  Sign in anonymously
                </button>
              </div>
            </div>

            <div>
              <strong>GPS status:</strong> {gpsStatus}
              {location && (
                <div>
                  Lat/Lng: {location.latitude.toFixed(6)}, {location.longitude.toFixed(6)} (±{Math.round(location.accuracy)} m)
                </div>
              )}
              {gpsError && (
                <div style={{ color: 'var(--color-error-text)' }}>{gpsError}</div>
              )}
            </div>

            <div>
              <strong>Team override:</strong>
              <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                <input
                  className="text-input"
                  style={{ padding: '4px 6px', fontSize: '11px' }}
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="Team name"
                />
                <button className="dev-btn" onClick={handleCreateTeam}>
                  Create
                </button>
              </div>
              <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                <input
                  className="text-input"
                  style={{ padding: '4px 6px', fontSize: '11px' }}
                  value={teamCode}
                  onChange={(e) => setTeamCode(e.target.value.toUpperCase())}
                  placeholder="Code"
                />
                <button className="dev-btn" onClick={handleJoinTeam}>
                  Join
                </button>
              </div>
            </div>

            <div style={{ color: 'var(--color-success-text)' }}>
              Server-controlled state: Checkpoint coordinates are never sent to the player.
            </div>
          </div>
        </details>
      )}
    </div>
  )
}

const isAdminMode =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('admin') === 'true'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isAdminMode ? <AdminApp /> : <App />}
  </React.StrictMode>
)
