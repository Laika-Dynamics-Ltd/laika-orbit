# Security

Laika Orbit reads your files, runs Claude Code chats and holds browser logins, so it is built to
answer only your own machine:

- The app server listens on `127.0.0.1` and refuses any request whose `Host` is not a loopback
  name, which stops DNS rebinding.
- Requests that change something must come from the app's own page: a cross-site form post or
  image tag is refused.
- The chat host listens on a random loopback port with a per-launch token kept in a file only
  you can read.
- Chats start only in folders the app knows (your repos and project folders), and ask before
  running tools unless you choose otherwise.
- Web pages in the browser run sandboxed, with no access to the app.

There is no login. Don't forward the port or run the server on a shared machine.

## Reporting a vulnerability

Email **laika@laikadynamics.com** with the details and steps to reproduce. Please don't open a
public issue. You'll get a reply within a few working days, and credit in the release notes if
you'd like it.
