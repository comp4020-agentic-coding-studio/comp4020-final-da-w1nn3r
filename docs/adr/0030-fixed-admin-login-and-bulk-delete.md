# ADR-0030: A fixed admin login with a login page, and bulk delete

- Status: accepted
- Date: 2026-10-14

## Context

ADR-0018 made `/admin` exist only when an `ADMIN_TOKEN` secret was set, with the
token as the password over HTTP Basic. On Fly no secret was set, so `/admin`
answered 404 and the owner could not clean up test accounts there. The browser's
Basic prompt is also not a login page and has no logout. The owner wants a fixed,
generic username and password (this is a class project), a proper login page, and
a way to delete many accounts at once, since the load test (ADR-0029) and the
specs leave many.

## Decision

1. **`/admin` is always on**, with a built-in login: username `admin`, password
   `ribbon-cable`. They are in the repo and therefore public; that is accepted
   here and stated in the README. `ADMIN_USER` and `ADMIN_PASSWORD` override them
   (an empty variable falls back to the default), `ADMIN_TOKEN` still works as the
   password so CI is unchanged, and `ADMIN_DISABLED=1` turns the route into a 404.
   Both the username and the password are compared, in constant time.
2. **A login page** at `/admin/login`. A correct login sets an `HttpOnly`,
   `SameSite=Strict`, path-scoped cookie `admin_session` holding an expiry and an
   HMAC of it (8 hours; `Secure` behind HTTPS). Nothing is kept on the server, so a
   machine stop does not log the admin out, and changing the password invalidates
   every session. An unauthenticated browser GET is redirected to the login page.
3. **Basic auth still works** for scripts: the specs and `scripts/load.ts` send it
   and get a 401, not a redirect, when it is wrong.
4. **Logout** is a POST (with the CSRF token) that clears the cookie.
5. **Bulk delete.** The dashboard has a checkbox per agent, select-all, a live
   count, and a "Delete selected" button that stays off until something is ticked.
   The POST needs the CSRF token and the word `DELETE`; up to 200 handles per
   request; an unknown handle is skipped. Each deletion is the existing
   `deleteAgent`, and one `bulk_delete` audit row records the handles.
6. **Everything else from ADR-0018 holds**: CSRF on every POST, same-origin
   check, 10 failed logins per IP per 15 minutes (a failed page login counts),
   escaped output, `no-store`. The admin CSP now also allows scripts from
   `'self'` for the select-all helper; the page works without it.
7. Admin actions and logins are written to the structured log (ADR-0028) as well
   as to `admin_log`.

## Alternatives considered

- Keep the token-only model and just set the secret: fixes today's 404 but not the
  login page, and leaves a Basic prompt with no logout.
- Server-side sessions in SQLite: revocable one by one, but needs a table and
  cleanup for no gain at this scale.
- A strong secret generated per deploy: right for real data, more than this
  assignment needs; the override variables allow it later.

## Consequences

Anyone who reads the repo can log in to the deployed admin and delete agents,
messages and profiles. That is the accepted cost; if the deployment ever holds
data that matters, set `ADMIN_USER` and `ADMIN_PASSWORD` with `fly secrets set`.
The lockout limits guessing, not use of the known password. The hard rule in
`CLAUDE.md` still holds: `/admin` and `/mcp` are the only write routes. This
supersedes only ADR-0018's "off unless ADMIN_TOKEN is set" and "any username"
points; the rest of ADR-0018 stands.
