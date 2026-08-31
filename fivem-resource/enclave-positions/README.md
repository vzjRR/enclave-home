# enclave-positions

A small FXServer resource that publishes anonymous player positions for the
enclaverp.cc homepage's mini-map. It writes `positions.json` — an array of
`{x, y}` pairs, coordinates only, no name, no player id — every 3 seconds,
and lets FXServer's own file server answer it over HTTP. It never touches
the server's global HTTP handling (`SetHttpHandler`), so it cannot conflict
with any other resource that does, including whatever is currently
rewriting `/players.json`'s `name` field on this box.

## Install

1. Copy this whole folder into your resources directory, **keeping the
   folder name exactly `enclave-positions`** — that name is the URL path
   segment the website requests (`/enclave-positions/positions.json`).
   Renaming it breaks the mini-map without any error message anywhere.
   ```
   resources/[local]/enclave-positions/
   ```
2. Add to `server.cfg`:
   ```
   ensure enclave-positions
   ```
3. Restart the resource (or the server):
   ```
   restart enclave-positions
   ```

## Verify it before turning the site's toggle on

```bash
curl -s http://127.0.0.1:30120/enclave-positions/positions.json
```

Should return `[]` with nobody online, or `[{"x":123,"y":-456},...]` with
players connected. If it 404s, the folder name is wrong or the resource
isn't `ensure`d. If it's stuck at `[]` with players connected, check the
server console for a Lua error from this resource on start.

Once that curl works, turn on **"عرض خريطة مواقع اللاعبين"** in
`/admin` → الإعدادات on the website — it reads this same URL through the
already-resolved server address, so nothing else needs configuring.

## Uninstall

Remove the `ensure enclave-positions` line from `server.cfg` and restart.
Nothing else on the server depends on this resource.
