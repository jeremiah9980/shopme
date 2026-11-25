# TeamPick

Two Favor runners, one coordinated H-E-B shopping trip.

Each runner adds a screen recording (or screenshots) of their Favor shopping lists. TeamPick reads the items, splits the departments between Jere and Jesica, gives each of you a live checklist, and regroups everything by customer at checkout so each order is scanned under the right Favor account.

TeamPick works only from what you upload or type. It never touches Favor or its checkout. Each runner stays responsible for Favor's policies and for customers' privacy.

## How it is put together

```
phone browser ──► public/index.html      the whole app, one file, no framework
                    │
                    ├─► /api/read  ──►  Anthropic API   (reads still frames; holds the API key)
                    └─► /api/data  ──►  Supabase table  (shared trips; holds the service key)
```

- Videos never leave the phone. The browser pulls out a still frame each time the list has scrolled about 40% of a screen, and only those stills are sent to be read.
- Both API routes require a team passcode that the two of you share.
- The second phone picks up changes by checking every 4 seconds. Simultaneous edits are merged, not overwritten.
- There are no npm dependencies. Node 20 or newer is all you need.

## Put it online

You need accounts at GitHub, Supabase, Anthropic (API) and Vercel. Free tiers of GitHub, Supabase and Vercel are enough; the Anthropic API bills per use.

### 1. GitHub

Create a repository (for example `team-pick`; private is fine) and upload everything in this folder.

If you upload through the website, drag the *contents* of the folder, not a zip. Two items are hidden by default on a Mac: `.github/` and `.gitignore`. Press `Cmd + Shift + .` in Finder to show them. With git instead:

```
git init && git add . && git commit -m "TeamPick"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/team-pick.git
git push -u origin main
```

### 2. Supabase (shared storage)

1. Create a project.
2. Open the SQL editor, paste the contents of `supabase/schema.sql`, and run it.
3. From the project's API settings, copy the **project URL** and the **secret key** (called `service_role` in older projects). Do not use the anon or publishable key.

### 3. Anthropic (reading the recordings)

Create an API key in the Claude Console at https://platform.claude.com.

### 4. Vercel

1. Add a new project and import the GitHub repository. Framework preset: **Other**. Leave the build settings alone; `vercel.json` sets them.
2. Add these environment variables, then deploy:

| Name | Value |
| --- | --- |
| `TEAM_PASSCODE` | A passcode you both know. At least 8 characters; the site stays locked if it is shorter. |
| `ANTHROPIC_API_KEY` | Your Anthropic API key. |
| `SUPABASE_URL` | Your Supabase project URL. |
| `SUPABASE_SERVICE_KEY` | Your Supabase secret / `service_role` key. |
| `ANTHROPIC_MODEL` | Optional. Model for the "Careful" setting. Default `claude-sonnet-5-5`. |
| `ANTHROPIC_MODEL_FAST` | Optional. Model for the "Faster" setting. Default `claude-haiku-5-5`. |

3. Open the site on both phones, type the passcode once, and use "Add to Home Screen" if you want an icon.
4. Optional: add your own domain under the project's Domains settings.

If you change an environment variable later, redeploy for it to take effect.

You can leave parts out. Without the Anthropic key, everything works except reading recordings (items are added by hand). Without Supabase, reading works but trips stay on the one phone.

## Run it on your computer

```
cp .env.example .env      # fill in what you have; all of it is optional locally
npm run dev               # http://localhost:3000
npm test
```

With no Supabase settings, the local server keeps trips in memory so you can try the full flow. With no `TEAM_PASSCODE`, it uses `local-dev-passcode`.

## Changing the app

Edit the files in `src/`, then run `npm run build` to regenerate `public/index.html`. Vercel also runs the build on every deploy.

| File | What is in it |
| --- | --- |
| `src/logic.js` | Departments and time estimates, name matching, de-duplication, workload balancing, scroll detection. No DOM. |
| `src/app.js` | The screens, the recording pipeline, and storage handling. |
| `src/standalone.js` | Connects the page to `/api/data` and `/api/read`, and shows the passcode prompt. |
| `src/style.css`, `src/shell.html` | Styles and the page skeleton. |
| `api/data.js`, `api/read.js`, `lib/server.js` | The two server routes and what they share. |
| `supabase/schema.sql` | The one table. |

Time estimates per department live at the top of `src/logic.js`. They are rough planning numbers, not measurements, and they know nothing about any particular store's layout.

## What has and has not been tested

Tested, in this repo's test suite or in a headless browser before publishing:

- Matching, de-duplication, customer carry-forward and balancing rules (`tests/logic.test.mjs`).
- The API routes: passcode, validation, merge-updates, retry on simultaneous edits, error mapping (`tests/api.test.mjs`).
- The full flow in a phone-sized Chromium with a synthetic scrolling recording, two browsers syncing, under the same security headers `vercel.json` sets.

Not tested, so treat the first real run as the test:

- **Real Favor recordings.** The reading instructions are written without knowing the app's exact layout. Expect to adjust the prompt in `src/app.js` (`promptFor`) after seeing real results.
- **iPhone Safari** video handling. If a video will not open, screenshots of the list work.
- **A real Supabase project, a real Vercel deployment, and the live Anthropic API.** These were exercised against stand-ins that mimic their request and response shapes.
- **The default model IDs.** If reading fails with a message about the model, set `ANTHROPIC_MODEL` and `ANTHROPIC_MODEL_FAST` to IDs from https://platform.claude.com/docs/en/about-claude/models/overview.

## Privacy and security

- Recordings stay on the phone. Still frames are sent to Anthropic to be read and are not stored by this app. The reading instructions say to ignore addresses, phone numbers and payment details, but those may still be visible in the frames that are sent.
- The trip stores product rows, customer names and notes. Delete trips when you are done; there is an optional clean-up query in `supabase/schema.sql`.
- The Supabase table has row level security on with no policies, so only the server routes can reach it.
- The passcode is the only gate, and there is no rate limiting on guesses. Use a long one, and change it in Vercel if a phone is lost.
- API keys exist only as environment variables on the server. Nothing secret is in this repository or in the page.

## Not built

History and analytics, store layouts and aisle maps, QR-code joining, offline queueing of ticks, product photos, help requests, and per-person logins.

## Troubleshooting

| What you see | Likely cause |
| --- | --- |
| No passcode prompt; "saved on this phone only" | `TEAM_PASSCODE` is missing or under 8 characters, or the site is on a static host with no `/api` routes (GitHub Pages cannot run them). |
| "Reading recordings isn't switched on" | `ANTHROPIC_API_KEY` is not set, or the deploy predates it. Redeploy. |
| Reading fails on every part | Check the Vercel function log for `/api/read`. A model or key message there says which setting to fix. |
| "That didn't save" | Check the function log for `/api/data`. Usually the Supabase URL or key, or `schema.sql` was not run. |
| Long recording, items missing | Recordings are capped at 48 stills. Scroll a little slower, or record each order separately. |
