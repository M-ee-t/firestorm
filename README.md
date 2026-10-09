# FIRESTORM

Mobile-first React/Vite foundation for the FIRESTORM geofenced campus clue hunt.

## Phase 1

- React + Vite
- HTTPS-ready Vercel deployment configuration
- Supabase environment placeholders
- Mobile-first shell
- No game logic yet

## Run locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Environment

Copy `.env.example` to `.env.local` after creating the Supabase project.

```text
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

## Architecture rules already locked

- Client never receives checkpoint coordinates.
- Proximity is only `cold | warm | hot`, returned by a rate-limited server function.
- Check-in accepts only coordinates + accuracy; the server derives the team's current target.
- Failed check-ins are persisted; only verification/award/unlock changes are transactional.
- Verification is server-side and will use a `SECURITY DEFINER` Postgres function with a team-row lock.
- Demo games are separate database rows; live games have no simulation control.
- Teams are created by the first player and joined by teammates using a short team code.
