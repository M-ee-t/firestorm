import React, { useEffect, useState, useCallback } from 'react'
import {
  MapContainer,
  TileLayer,
  Marker,
  useMapEvents,
} from 'react-leaflet'
import { supabase } from './lib/supabase'
import './admin.css'

// ─────────────────────────────────────────────────────────────
// Tiny helper: extract a readable message from a Supabase error
// ─────────────────────────────────────────────────────────────
function rpcErrMsg(err) {
  if (!err) return 'Unknown error'
  // Supabase PGRST wraps the DB message in err.message
  return err.message || String(err)
}

// ─────────────────────────────────────────────────────────────
// Map click handler — sets lat/lng when the user clicks the map
// ─────────────────────────────────────────────────────────────
function MapClickSetter({ onCoords }) {
  useMapEvents({
    click(e) {
      onCoords(e.latlng.lat, e.latlng.lng)
    },
  })
  return null
}

// ─────────────────────────────────────────────────────────────
// Small coordinate map used inside the checkpoint editor
// ─────────────────────────────────────────────────────────────
function CoordMap({ lat, lng, onCoords }) {
  const defaultCenter = [22.6811, 75.8805]
  const center =
    lat && lng && isFinite(lat) && isFinite(lng)
      ? [parseFloat(lat), parseFloat(lng)]
      : defaultCenter

  return (
    <MapContainer
      key={`${center[0]},${center[1]}`}
      center={center}
      zoom={17}
      scrollWheelZoom={false}
      style={{ height: '100%', width: '100%' }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <MapClickSetter onCoords={onCoords} />
      {lat && lng && isFinite(parseFloat(lat)) && isFinite(parseFloat(lng)) && (
        <Marker position={[parseFloat(lat), parseFloat(lng)]} />
      )}
    </MapContainer>
  )
}

// ─────────────────────────────────────────────────────────────
// CHECKPOINT EDITOR MODAL
// ─────────────────────────────────────────────────────────────
const EMPTY_FORM = {
  name: '',
  latitude: '',
  longitude: '',
  radius_m: '30',
  max_accuracy_m: '50',
  order_index: '',
  points_full: '100',
  points_late: '50',
  clue_text: '',
  hint_text: '',
  is_core: false,
  active: true,
}

function CheckpointEditor({ checkpoint, gameId, onSaved, onCancel }) {
  const isNew = !checkpoint?.id

  // Initialise form from the checkpoint being edited (or blank for new)
  const [form, setForm] = useState(() => {
    if (isNew) return { ...EMPTY_FORM }
    return {
      name: checkpoint.name ?? '',
      latitude: String(checkpoint.latitude ?? ''),
      longitude: String(checkpoint.longitude ?? ''),
      radius_m: String(checkpoint.radius_m ?? '30'),
      max_accuracy_m: String(checkpoint.max_accuracy_m ?? '50'),
      order_index: String(checkpoint.order_index ?? ''),
      points_full: String(checkpoint.points_full ?? '100'),
      points_late: String(checkpoint.points_late ?? '50'),
      clue_text: checkpoint.clue_text ?? '',
      hint_text: checkpoint.hint_text ?? '',
      is_core: Boolean(checkpoint.is_core),
      active: checkpoint.active !== false,
    }
  })

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }))
    setFieldErrors((fe) => ({ ...fe, [field]: '' }))
    setError('')
    setSuccess('')
  }

  // Map click → fill lat/lng fields
  function handleMapClick(lat, lng) {
    set('latitude', lat.toFixed(7))
    set('longitude', lng.toFixed(7))
  }

  // Client-side validation before calling the RPC
  function validate() {
    const fe = {}
    if (!form.name.trim()) fe.name = 'Required'
    const lat = parseFloat(form.latitude)
    const lng = parseFloat(form.longitude)
    if (isNaN(lat) || lat < -90 || lat > 90) fe.latitude = '-90 to 90'
    if (isNaN(lng) || lng < -180 || lng > 180) fe.longitude = '-180 to 180'
    const r = parseFloat(form.radius_m)
    if (isNaN(r) || r <= 0 || r > 1000) fe.radius_m = '1–1000 m'
    const ma = parseFloat(form.max_accuracy_m)
    if (isNaN(ma) || ma <= 0 || ma > 200) fe.max_accuracy_m = '1–200 m'
    const oi = parseInt(form.order_index, 10)
    if (isNaN(oi) || oi < 1) fe.order_index = '≥ 1'
    const pf = parseInt(form.points_full, 10)
    const pl = parseInt(form.points_late, 10)
    if (isNaN(pf) || pf < 0) fe.points_full = '≥ 0'
    if (isNaN(pl) || pl < 0) fe.points_late = '≥ 0'
    if (!form.clue_text.trim()) fe.clue_text = 'Required'
    return fe
  }

  async function handleSave() {
    setError('')
    setSuccess('')
    const fe = validate()
    if (Object.keys(fe).length > 0) {
      setFieldErrors(fe)
      return
    }

    setSaving(true)
    try {
      // Build the payload exactly as the RPC expects
      const payload = {
        game_id: gameId,
        name: form.name.trim(),
        latitude: parseFloat(form.latitude),
        longitude: parseFloat(form.longitude),
        radius_m: parseFloat(form.radius_m),
        max_accuracy_m: parseFloat(form.max_accuracy_m),
        order_index: parseInt(form.order_index, 10),
        points_full: parseInt(form.points_full, 10),
        points_late: parseInt(form.points_late, 10),
        clue_text: form.clue_text.trim(),
        hint_text: form.hint_text.trim() || null,
        is_core: form.is_core,
        active: form.active,
      }
      // Include id only for edits
      if (!isNew) {
        payload.id = checkpoint.id
      }

      const { data, error: rpcErr } = await supabase.rpc(
        'admin_save_checkpoint',
        { p_checkpoint: payload }
      )

      if (rpcErr) {
        throw rpcErr
      }

      setSuccess(data?.message || 'Checkpoint saved successfully.')
      onSaved()
    } catch (err) {
      setError(rpcErrMsg(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="admin-modal-overlay" onClick={onCancel}>
      <div
        className="admin-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="admin-modal-header">
          <span className="admin-modal-title">
            {isNew ? 'Add Checkpoint' : `Edit: ${checkpoint.name}`}
          </span>
          <button className="btn-modal-close" onClick={onCancel}>
            ×
          </button>
        </div>

        {/* Body */}
        <div className="admin-modal-body">
          {error && <div className="admin-error-msg">{error}</div>}
          {success && <div className="admin-success-msg">{success}</div>}

          {/* Advisory */}
          <div className="admin-advisory">
            Core must have the highest order index and be the final checkpoint.
            Only one active Core per game is allowed.
          </div>

          {/* Name + Order */}
          <div className="form-row">
            <div className="form-field">
              <label>
                Name<span className="req">*</span>
              </label>
              <input
                className={`admin-input-full${fieldErrors.name ? ' has-error' : ''}`}
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="e.g. Clock Tower"
                maxLength={100}
              />
              {fieldErrors.name && (
                <span className="field-error">{fieldErrors.name}</span>
              )}
            </div>
            <div className="form-field">
              <label>
                Order Index<span className="req">*</span>
              </label>
              <input
                className={`admin-input-full${fieldErrors.order_index ? ' has-error' : ''}`}
                type="number"
                min="1"
                value={form.order_index}
                onChange={(e) => set('order_index', e.target.value)}
                placeholder="1"
              />
              {fieldErrors.order_index && (
                <span className="field-error">{fieldErrors.order_index}</span>
              )}
            </div>
          </div>

          {/* Lat / Lng */}
          <div className="form-row">
            <div className="form-field">
              <label>
                Latitude<span className="req">*</span>
              </label>
              <input
                className={`admin-input-full${fieldErrors.latitude ? ' has-error' : ''}`}
                type="number"
                step="any"
                value={form.latitude}
                onChange={(e) => set('latitude', e.target.value)}
                placeholder="22.6811"
              />
              {fieldErrors.latitude && (
                <span className="field-error">{fieldErrors.latitude}</span>
              )}
            </div>
            <div className="form-field">
              <label>
                Longitude<span className="req">*</span>
              </label>
              <input
                className={`admin-input-full${fieldErrors.longitude ? ' has-error' : ''}`}
                type="number"
                step="any"
                value={form.longitude}
                onChange={(e) => set('longitude', e.target.value)}
                placeholder="75.8805"
              />
              {fieldErrors.longitude && (
                <span className="field-error">{fieldErrors.longitude}</span>
              )}
            </div>
          </div>

          {/* Map */}
          <div>
            <div
              className="admin-map-frame"
              style={{ position: 'relative' }}
            >
              <CoordMap
                lat={form.latitude}
                lng={form.longitude}
                onCoords={handleMapClick}
              />
            </div>
            <div className="admin-map-hint">
              Click the map to set coordinates, or enter them manually above.
            </div>
          </div>

          {/* Radius / Accuracy */}
          <div className="form-row">
            <div className="form-field">
              <label>
                Radius (m)<span className="req">*</span>
              </label>
              <input
                className={`admin-input-full${fieldErrors.radius_m ? ' has-error' : ''}`}
                type="number"
                min="1"
                max="1000"
                value={form.radius_m}
                onChange={(e) => set('radius_m', e.target.value)}
              />
              {fieldErrors.radius_m && (
                <span className="field-error">{fieldErrors.radius_m}</span>
              )}
            </div>
            <div className="form-field">
              <label>
                Max GPS Accuracy (m)<span className="req">*</span>
              </label>
              <input
                className={`admin-input-full${fieldErrors.max_accuracy_m ? ' has-error' : ''}`}
                type="number"
                min="1"
                max="200"
                value={form.max_accuracy_m}
                onChange={(e) => set('max_accuracy_m', e.target.value)}
              />
              {fieldErrors.max_accuracy_m && (
                <span className="field-error">
                  {fieldErrors.max_accuracy_m}
                </span>
              )}
            </div>
          </div>

          {/* Points */}
          <div className="form-row">
            <div className="form-field">
              <label>
                Full Points<span className="req">*</span>
              </label>
              <input
                className={`admin-input-full${fieldErrors.points_full ? ' has-error' : ''}`}
                type="number"
                min="0"
                value={form.points_full}
                onChange={(e) => set('points_full', e.target.value)}
              />
              {fieldErrors.points_full && (
                <span className="field-error">{fieldErrors.points_full}</span>
              )}
            </div>
            <div className="form-field">
              <label>
                Late Points<span className="req">*</span>
              </label>
              <input
                className={`admin-input-full${fieldErrors.points_late ? ' has-error' : ''}`}
                type="number"
                min="0"
                value={form.points_late}
                onChange={(e) => set('points_late', e.target.value)}
              />
              {fieldErrors.points_late && (
                <span className="field-error">{fieldErrors.points_late}</span>
              )}
            </div>
          </div>

          {/* Clue */}
          <div className="form-field">
            <label>
              Clue Text<span className="req">*</span>
            </label>
            <textarea
              className={`admin-textarea${fieldErrors.clue_text ? ' has-error' : ''}`}
              value={form.clue_text}
              onChange={(e) => set('clue_text', e.target.value)}
              maxLength={2000}
              placeholder="The clue players will see for this checkpoint…"
            />
            {fieldErrors.clue_text && (
              <span className="field-error">{fieldErrors.clue_text}</span>
            )}
          </div>

          {/* Hint */}
          <div className="form-field">
            <label>Hint Text (optional — costs points to unlock)</label>
            <textarea
              className="admin-textarea"
              value={form.hint_text}
              onChange={(e) => set('hint_text', e.target.value)}
              maxLength={1000}
              placeholder="Optional additional hint…"
            />
          </div>

          {/* Toggles */}
          <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={form.is_core}
                onChange={(e) => set('is_core', e.target.checked)}
              />
              <span className="toggle-label">Is Core (final checkpoint)</span>
            </label>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => set('active', e.target.checked)}
              />
              <span className="toggle-label">Active</span>
            </label>
          </div>
        </div>

        {/* Footer */}
        <div className="admin-modal-footer">
          <button className="btn-cancel" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button
            className="btn-save"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save Checkpoint'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// CHECKPOINT LIST SECTION
// ─────────────────────────────────────────────────────────────
function CheckpointSection({ gameId }) {
  const [checkpoints, setCheckpoints] = useState([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [editing, setEditing] = useState(null) // null | 'new' | checkpoint obj

  const loadCheckpoints = useCallback(async () => {
    if (!gameId) return
    setLoading(true)
    setLoadError('')
    try {
      const { data, error } = await supabase.rpc('admin_get_checkpoints', {
        p_game_id: gameId,
      })
      if (error) throw error
      // data is a JSONB array from Postgres
      setCheckpoints(Array.isArray(data) ? data : [])
    } catch (err) {
      setLoadError(rpcErrMsg(err))
    } finally {
      setLoading(false)
    }
  }, [gameId])

  useEffect(() => {
    loadCheckpoints()
  }, [loadCheckpoints])

  function handleSaved() {
    loadCheckpoints()
    // Keep editor open so the success message is visible; user clicks Cancel to close
  }

  return (
    <div className="admin-card">
      <div className="admin-cp-header">
        <span className="admin-card-title" style={{ marginBottom: 0 }}>
          Checkpoints
        </span>
        <button
          className="btn-add-cp"
          onClick={() => setEditing('new')}
          disabled={!gameId}
        >
          + Add Checkpoint
        </button>
      </div>

      {loadError && <div className="admin-error-msg">{loadError}</div>}

      {loading ? (
        <div className="admin-state-msg">Loading checkpoints…</div>
      ) : checkpoints.length === 0 ? (
        <div className="admin-state-msg">
          No checkpoints found for this game.
        </div>
      ) : (
        <div className="admin-cp-table-wrap">
          <table className="admin-cp-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Name</th>
                <th>Type</th>
                <th>Status</th>
                <th>Radius</th>
                <th>Points</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {checkpoints.map((cp) => (
                <tr key={cp.id} className={cp.active ? '' : 'cp-inactive'}>
                  <td>{cp.order_index}</td>
                  <td className="cp-name-cell">{cp.name}</td>
                  <td>
                    {cp.is_core ? (
                      <span className="tag tag-core">Core</span>
                    ) : (
                      <span style={{ color: 'var(--text-dim)', fontSize: '11px' }}>
                        Normal
                      </span>
                    )}
                  </td>
                  <td>
                    {cp.active ? (
                      <span className="tag tag-active">Active</span>
                    ) : (
                      <span className="tag tag-inactive">Inactive</span>
                    )}
                  </td>
                  <td>{cp.radius_m} m</td>
                  <td>
                    {cp.points_full} / {cp.points_late}
                  </td>
                  <td>
                    <button
                      className="btn-edit"
                      onClick={() => setEditing(cp)}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Editor modal */}
      {editing !== null && (
        <CheckpointEditor
          checkpoint={editing === 'new' ? null : editing}
          gameId={gameId}
          onSaved={handleSaved}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// GAME SELECTOR SECTION
// ─────────────────────────────────────────────────────────────
function GameSelector({ selectedGameId, onSelect }) {
  const [games, setGames] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError('')
      try {
        const { data, error } = await supabase.rpc('admin_get_games')
        if (error) throw error
        setGames(Array.isArray(data) ? data : [])
      } catch (err) {
        setError(rpcErrMsg(err))
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  function statusTag(status) {
    switch (status) {
      case 'live':
        return <span className="tag tag-status-live">Live</span>
      case 'finished':
        return <span className="tag tag-status-finished">Finished</span>
      default:
        return <span className="tag tag-status-waiting">Waiting</span>
    }
  }

  return (
    <div className="admin-card">
      <div className="admin-card-title">Games</div>
      {error && <div className="admin-error-msg">{error}</div>}
      {loading ? (
        <div className="admin-state-msg">Loading games…</div>
      ) : games.length === 0 ? (
        <div className="admin-state-msg">No games found.</div>
      ) : (
        <div className="admin-game-list">
          {games.map((g) => (
            <div
              key={g.id}
              className={`admin-game-row${selectedGameId === g.id ? ' selected' : ''}`}
              onClick={() => onSelect(g.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && onSelect(g.id)}
            >
              <span className="admin-game-name">{g.name}</span>
              <span className="admin-game-meta">
                {statusTag(g.status)}
                <span
                  className={`tag ${g.demo_game ? 'tag-demo' : 'tag-live'}`}
                >
                  {g.demo_game ? 'Demo' : 'Live'}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// ORGANIZER DASHBOARD (shown after login + is_admin check)
// ─────────────────────────────────────────────────────────────
function Dashboard({ user, onSignOut }) {
  const [selectedGameId, setSelectedGameId] = useState(null)

  return (
    <div className="admin-root">
      {/* Header */}
      <header className="admin-header">
        <div className="admin-header-brand">
          <span className="admin-header-title">FIRESTORM</span>
          <span className="admin-header-subtitle">Organizer Console</span>
        </div>
        <div className="admin-header-right">
          <span className="admin-header-email">{user.email}</span>
          <button className="btn-signout" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      {/* Body */}
      <main className="admin-body">
        <GameSelector
          selectedGameId={selectedGameId}
          onSelect={setSelectedGameId}
        />
        {selectedGameId && (
          <CheckpointSection gameId={selectedGameId} />
        )}
        {!selectedGameId && (
          <div className="admin-state-msg" style={{ color: 'var(--text-dim)' }}>
            Select a game above to manage its checkpoints.
          </div>
        )}
      </main>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// ADMIN LOGIN FORM
// ─────────────────────────────────────────────────────────────
function AdminLogin({ onAuthorized }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleLogin(e) {
    e.preventDefault()
    setError('')

    if (!email.trim() || !password) {
      setError('Email and password are required.')
      return
    }

    setLoading(true)
    try {
      // 1. Sign in with email/password (not anonymous)
      const { data: authData, error: authErr } =
        await supabase.auth.signInWithPassword({ email, password })
      if (authErr) throw authErr

      const user = authData.user
      if (!user) throw new Error('Sign-in did not return a user.')

      // 2. Server-side authorization check via is_admin() RPC
      const { data: isAdmin, error: rpcErr } = await supabase.rpc('is_admin')
      if (rpcErr) throw rpcErr

      if (!isAdmin) {
        // Sign back out so the session is not retained
        await supabase.auth.signOut()
        throw new Error(
          'Access denied: your account is not registered as an organizer.'
        )
      }

      onAuthorized(user)
    } catch (err) {
      setError(rpcErrMsg(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="admin-login-wrap">
      <div className="admin-login-card">
        <div className="admin-login-brand">
          <div className="admin-login-brand-title">FIRESTORM</div>
          <div className="admin-login-brand-sub">Organizer Console</div>
        </div>

        {error && <div className="admin-login-error">{error}</div>}

        <form className="admin-login-form" onSubmit={handleLogin}>
          <div className="admin-field-group">
            <label className="admin-field-label">Email</label>
            <input
              className="admin-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="organizer@example.com"
              disabled={loading}
            />
          </div>
          <div className="admin-field-group">
            <label className="admin-field-label">Password</label>
            <input
              className="admin-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••••"
              disabled={loading}
            />
          </div>
          <button
            type="submit"
            className="btn-admin-primary"
            disabled={loading}
          >
            {loading ? 'Verifying…' : 'Sign In as Organizer'}
          </button>
        </form>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// ROOT ADMIN APP
// Handles: checking existing session → is_admin RPC → render
// ─────────────────────────────────────────────────────────────
export function AdminApp() {
  // 'checking' | 'login' | 'denied' | 'authorized'
  const [authState, setAuthState] = useState('checking')
  const [user, setUser] = useState(null)

  // On mount, check if there is already an active Supabase session
  // and whether that session belongs to an admin.
  useEffect(() => {
    let mounted = true

    async function checkExistingSession() {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session?.user) {
          if (mounted) setAuthState('login')
          return
        }

        // Re-verify is_admin for any existing session.
        const { data: isAdmin, error: rpcErr } = await supabase.rpc('is_admin')
        if (rpcErr || !isAdmin) {
          // Not an admin; clear session and show login
          await supabase.auth.signOut()
          if (mounted) setAuthState('login')
          return
        }

        if (mounted) {
          setUser(session.user)
          setAuthState('authorized')
        }
      } catch {
        if (mounted) setAuthState('login')
      }
    }

    checkExistingSession()
    return () => { mounted = false }
  }, [])

  async function handleSignOut() {
    await supabase.auth.signOut()
    setUser(null)
    setAuthState('login')
  }

  function handleAuthorized(loggedInUser) {
    setUser(loggedInUser)
    setAuthState('authorized')
  }

  if (authState === 'checking') {
    return (
      <div className="admin-login-wrap">
        <div style={{ color: 'var(--text-dim)', fontSize: '13px' }}>
          Checking session…
        </div>
      </div>
    )
  }

  if (authState === 'login') {
    return <AdminLogin onAuthorized={handleAuthorized} />
  }

  if (authState === 'authorized' && user) {
    return <Dashboard user={user} onSignOut={handleSignOut} />
  }

  // Fallback access-denied (should not normally be reached)
  return (
    <div className="admin-login-wrap">
      <div className="admin-denied-card" style={{ maxWidth: 400 }}>
        <h3>Access Denied</h3>
        <p>
          Your account is not registered as an organizer. Contact the event
          administrator to be added to the <code>app_admins</code> table.
        </p>
        <button
          className="btn-admin-primary"
          style={{ marginTop: 14 }}
          onClick={handleSignOut}
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
