# weKnow Staff Bookings

A local Gantt-style staff booking system for weKnow — table + timeline views,
full create / edit / delete, drag-to-reschedule, filters, light/dark.

Opens in the **Table** view. The **Timeline** is a day-by-day Gantt (month + day
header, weekends shaded); **click a month name** to zoom it to fill the screen,
**Today** jumps to the red today marker, **+ / −** zoom. The background sync only
redraws when data actually changed, so your scroll position stays put.
Set a profile photo from the avatar menu, top-right.

## Where this runs

This app lives inside the weknowinc.com site repo (`staff/`) and is served at
**https://weknowinc.com/staff**. It is still its own process — a zero-dependency
Node server that owns its own data — and the Next.js site simply proxies `/staff`
to it. See [Serving it under weknowinc.com/staff](#serving-it-under-weknowinccomstaff)
for how that is wired and what to set on the server.

## Run it

From the repo root, this starts the site *and* this app together:

```bash
npm run dev     # site on :3000, bookings at http://localhost:3000/staff
```

Or run it standalone, exactly as before — no site, no proxy:

```bash
node staff/server.js
```

Then open **http://localhost:4173** in Chrome.

- Change the port: `PORT=5000 node server.js`
- Stop it: `Ctrl+C` in the terminal

No `npm install` needed — the server has zero dependencies (plain Node ≥ 18).

### Configuration — `.env`

Copy **`.env.example` → `.env`** and fill in what you need (port, public URL,
admin contact, SMTP, HTTPS, data directory). Anything in `.env` can also be
passed as a normal environment variable — the shell wins over `.env`.

```bash
cp .env.example .env   # then edit
node server.js
```

### HTTPS

Runs on plain HTTP by default (fine on `localhost`). Once it's reachable from
other machines, give it TLS: point `WK_TLS_CERT` / `WK_TLS_KEY` at PEM files.
For a quick self-signed pair to test with:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout data/tls.key -out data/tls.crt -days 365 -subj "/CN=localhost"
```

Session cookies are automatically marked `Secure` when TLS is on.

### Backups &amp; activity log

- Every change **snapshots the previous `bookings.json` / `config.json` / `users.json`**
  into `data/backups/` (at most one snapshot per file per 5 min, newest 40 kept).
  To restore: stop the server, copy a snapshot back over the live file, start again.
- Sign-ins, edits, deletes, invites and field changes are appended to
  `data/audit.log` (one JSON object per line). Admins can read the last 300
  entries from **Tools ▾ → Activity**.

### Test it

```bash
node test.js       # or: npm test
```

Boots the server against a throwaway data directory on port 4199 and runs an
end-to-end API check (auth, CRUD, config, CSV, audit, backups). Exit code 0 = all green.

## Serving it under weknowinc.com/staff

The marketing site (Next.js) and this app are two processes on one host:

```
browser -> Cloudflare -> Render -> Next.js :$PORT ──/staff/*──> staff/server.js :4173 (loopback)
                                        └─ everything else ─> the marketing site
```

`npm start` at the repo root boots both (`scripts/start-with-staff.mjs`). The
pieces that make `/staff` work:

| Where | What it does |
|---|---|
| `next.config.mjs` → `rewrites()` | proxies `/staff` and `/staff/*` to `STAFF_ORIGIN` |
| `next.config.mjs` → `skipTrailingSlashRedirect` | stops Next from 308-ing every `/staff/api/*` call |
| `src/middleware.ts` | re-implements the site's trailing-slash redirect, skipping `/staff` |
| `WK_BASE_PATH=/staff` (this server) | strips the prefix from requests and adds it to every URL the app hands back |

The app binds to `127.0.0.1`, so it is reachable only through the site — there is
no second public port and no second certificate.

### Deploying

Set these on the service (Render → Environment):

| Variable | Value | Why |
|---|---|---|
| `WK_DATA_DIR` | a path on a **persistent disk**, e.g. `/var/data/staff` | **Required.** Bookings, accounts and the session key are files. On an ephemeral filesystem every deploy wipes them and everyone is logged out. |
| `WK_APP_URL` | `https://weknowinc.com/staff` | the link inside invitation emails |
| `WK_ADMIN_CONTACT` | `it@weknowinc.com` | the "Contact your admin" link on the sign-in screen |
| `WK_ADMIN_PASSWORD` | a strong password | read **only on the very first run**, to create the first admin. Leave it unset and the server prints a random one to the deploy log instead. |
| `WK_SMTP_HOST` / `_USER` / `_PASS` / `_FROM` | your mail provider | without these, invites show the temp password on screen instead of emailing it |

`WK_SECURE_COOKIES=1` is set for you in production by the start script, because
TLS terminates at Cloudflare and the session cookie still has to be `Secure`.

To move this app to its own service later, point `STAFF_ORIGIN` at it (e.g.
`https://bookings.internal`) — the site proxies there instead and stops starting
a local copy. Nothing else changes.

### Updating from the standalone repo

The code is vendored with `git subtree` from `TCS231107/WK-staff-booking`:

```bash
git subtree pull --prefix=staff git@github.com:TCS231107/WK-staff-booking.git main --squash
```

The mount-point changes here (`WK_BASE_PATH`, `WK_BIND`, `WK_SECURE_COOKIES`) are
inert when those variables are unset, so the standalone install still behaves
exactly as it always did and the two copies stay mergeable.

## Signing in

On the **first run** the server creates an admin account and prints it:

```
  Sign-in ready   username: admin   password: <random>
```

Copy that password to sign in. To pick your own instead, set `WK_ADMIN_PASSWORD`
in `.env` (or the environment) before the first run.

Set `WK_ADMIN_CONTACT` to an email address and it shows up on the sign-in screen
as the "Contact your admin" link for access / password-reset help.

- Accounts live in `data/users.json` (passwords are scrypt-hashed, never stored plain).
- Sessions are signed cookies (12 h, or 30 days with *Keep me signed in*); the
  signing key is `data/.session-secret`.
- Every `/api/*` call except the login endpoints requires a valid session.
- Sign out / change your password from the avatar menu, top-right.

## Team &amp; invitations — **Tools ▾ → Team**

- Everyone can see who has access. **Only admins** can invite or manage people.
- **Invite**: enter the person's email (and name), pick Member or Admin, *Send invite*.
  A pending account is created with a one-time temporary password.
- The invited person signs in with that password and is **forced to set their own**
  on first login.
- Per-member menu (admins): resend invite, make admin / member, disable access, remove.
- An admin can't remove their own admin rights or disable themselves, and the
  workspace always keeps at least one active admin.

### Sending the invitation email

By default there's **no mail server**, so after inviting you get the temporary
password and a **"Preview the invitation email"** link on screen — copy those to the
person yourself. The email is also saved to `public/invites/<token>.html`.

To send for real, set these before starting the server (SMTP over TLS, port 465):

```bash
WK_SMTP_HOST=smtp.yourprovider.com \
WK_SMTP_USER=you@weknowinc.com \
WK_SMTP_PASS=yourpassword \
WK_SMTP_FROM='weKnow Staff Bookings <no-reply@weknowinc.com>' \
WK_APP_URL=http://your-machine:4173 \
node server.js
```

## Manage fields — **Tools ▾ → Manage fields** (top right)

### Fields tab — the columns themselves

- **Add a field** — name it, pick a type (Text / Number / Date / Checkbox /
  Single select), click *Add field*. It shows up as a column and in the booking form.
  A Single select field takes a comma-separated list of options.
- **Rename** any field (built-in or custom).
- **Description** — an optional note per field (like Airtable's field description).
- **Change type** of a custom field with its type dropdown (values are re-coerced).
- **Reorder** with the ▲▼ arrows — the table columns follow.
- **Hide / show** a field in the table with its *Shown* checkbox (hidden fields
  still appear in the booking form).
- **Delete** a custom field (built-in fields can't be deleted). Its values are
  removed from every booking.

### Employees tab — the people roster

- **Add** an employee (they appear as suggestions in the *Employee* field of a booking).
- **Rename** an employee → every booking of theirs is updated automatically.
- **Remove** an employee from the roster (it only drops the suggestion — their
  bookings keep the name; delete a booking from its row's ⤢ → *Delete*).
- Typing a new name straight into a booking's *Employee* field also adds it here.

### Option tabs — Status / Clients / Tech profile / Delivery mgrs

- Add / rename / recolour / remove the choices for those dropdown fields.
- **Renaming an option rewrites every booking that uses it.** Removing one leaves
  existing bookings untouched (they keep the old text, shown in grey).
- Typing a brand-new client / role / delivery manager straight into a booking
  also adds it to the list automatically.

Everything here lives in `data/config.json`.

## Table view — works like a spreadsheet

- **Click any cell to edit it in place.** `Enter` saves, `Esc` cancels
  (`Cmd/Ctrl+Enter` saves a Notes cell). Status and dates save as soon as you pick.
- **Notes wrap fully** — the row grows to fit, nothing is cut off.
- **Drag a column's right border** to widen or narrow it. Widths are remembered
  in your browser.
- Hover a row and click the ⤢ icon (in the Employee cell) to open the full form.

## How it works

| Piece | File |
|---|---|
| HTTP server + REST API + static hosting | `server.js` |
| The app (UI, all in one file) | `public/index.html` |
| Your bookings (created on first run) | `data/bookings.json` |
| Field options — statuses, clients, roles, delivery managers | `data/config.json` |
| User accounts (scrypt-hashed passwords) | `data/users.json` |
| Automatic point-in-time snapshots | `data/backups/` |
| Activity log (sign-ins, edits, invites…) | `data/audit.log` |
| Smoke test | `test.js` |
| Configuration | `.env` (see `.env.example`) |

The browser talks to a small JSON API:

```
GET    /api/bookings          list all
POST   /api/bookings          create   (body: booking fields)
PATCH  /api/bookings/:id      partial update (used by drag-to-reschedule)
PUT    /api/bookings/:id      full replace
DELETE /api/bookings/:id      remove
GET    /api/bookings/export.csv  download every booking as CSV
GET    /api/config            field options (statuses, clients, roles, delivery managers)
PUT    /api/config            replace config  (body: {config, renames})
GET    /api/audit             last 300 activity-log entries (admin)
GET    /api/auth/context      { adminContact, appUrl }  — public, no session
POST   /api/auth/login        {username, password, remember}  → sets session cookie
POST   /api/auth/logout       clears the session
GET    /api/auth/me           current user, or 401
POST   /api/auth/password     {current?, next}  → change your password
POST   /api/auth/avatar       {dataUrl}  → set profile photo  ·  DELETE to remove
GET    /api/team              list members
POST   /api/team              {email, name, role}  → invite (admin)
POST   /api/team/:id/resend   new temp password + resend (admin)
PATCH  /api/team/:id          {role} / {status}  (admin)
DELETE /api/team/:id          remove member (admin)
```

Every change is written to `data/bookings.json`. Open the app in several tabs or
on other machines on your network (`http://<your-ip>:4173`) — each tab refreshes
from the server every 7 seconds, so edits show up for everyone.

## Booking fields

`name`, `roles[]` (technical profile), `client`, `status`
(`Extend` / `Safe` / `Risk` / `Exit` / `N/A`), `start`, `end`,
`mainPM`, `pmEmail`, `deliveryManager`, `billable`, `contract` (URL), `notes`.

Legacy status values (`At risk`, `Rolling off`, `On hold`) are auto-migrated
to `Risk` / `Exit` / `N/A` on server start.

## Export / print

- **Tools ▾ → Export CSV** downloads every booking (visible columns) as a
  spreadsheet. `/api/bookings/export.csv` does the same over HTTP.
- **Tools ▾ → Print** switches to the table and opens the browser print dialog
  with a clean black-on-white layout — "Save as PDF" from there.
- **Tools ▾ → Duplicate** (inside a booking's form) makes a copy named "… (copy)".

## Reset / import data

- **Reset to the sample set:** stop the server, delete `data/bookings.json`, start again.
- **Import your real data:** stop the server, replace `data/bookings.json` with an
  array of booking objects (same field names as above; `id` optional), start again.
- **Restore a backup:** stop the server, copy a file out of `data/backups/` over
  the live one (drop the timestamp from the name), start again.

## Not built yet

- PTOs / holidays / vacations — scoped out of v1.
- Employees / Clients as their own full views (they exist as lists in *Manage fields*).
- Real "forgot password" and SSO flows (the buttons explain who to contact).
- Live updates are 7-second polling, not push.
