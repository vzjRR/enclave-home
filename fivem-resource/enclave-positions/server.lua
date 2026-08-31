-- Writes positions.json every 3s: an array of {x, y} for every connected
-- player, coordinates only, rounded to whole numbers. No name, no id, no z
-- (a 2D mini-map has no use for either) -- see this repo's top-level
-- README ("Where the data comes from") for why that's deliberate.
--
-- Never touches the server's global HTTP handling (no SetHttpHandler), so
-- it cannot conflict with any other resource that does. FXServer serves
-- this file itself, at http://<address>/enclave-positions/positions.json,
-- because fxmanifest.lua declares it under `files`.

local UPDATE_INTERVAL_MS = 3000

local function round(n)
    return math.floor(n + 0.5)
end

local function collectPositions()
    local positions = {}

    for _, playerId in ipairs(GetPlayers()) do
        local ped = GetPlayerPed(playerId)
        -- 0 means the player hasn't spawned a ped yet (still loading in) --
        -- nothing to plot for them this cycle.
        if ped ~= 0 then
            local coords = GetEntityCoords(ped)
            table.insert(positions, { x = round(coords.x), y = round(coords.y) })
        end
    end

    return positions
end

local function writePositions()
    local ok, positions = pcall(collectPositions)
    if not ok then
        -- A bad read this cycle shouldn't take the loop down -- leave the
        -- previous file in place and try again next tick.
        return
    end

    -- json.encode({}) on an empty table produces "{}", not "[]" -- Lua
    -- can't tell an empty array from an empty object. Write the array
    -- literal by hand for that one case rather than shipping a payload
    -- the site's JSON.parse would read as an object.
    local body = (#positions == 0) and '[]' or json.encode(positions)

    SaveResourceFile(GetCurrentResourceName(), 'positions.json', body, -1)
end

CreateThread(function()
    while true do
        writePositions()
        Wait(UPDATE_INTERVAL_MS)
    end
end)
