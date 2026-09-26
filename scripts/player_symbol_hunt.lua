local TAG = "[player-symbol]"

local function log(msg)
    cfb.log(TAG .. " " .. msg)
end

local function ascii_pattern(s)
    local out = {}

    for i = 1, #s do
        out[#out + 1] = string.format("%02X", string.byte(s, i))
    end

    return table.concat(out, " ")
end

local function safe_u8(addr)
    local ok, value = pcall(cfb.read_u8, addr)

    if not ok then
        return nil
    end

    return value
end

local function printable(b)
    return b ~= nil and b >= 32 and b <= 126
end

local function containing_string(hit)
    local startAddr = hit

    --
    -- Walk backward to the beginning of the printable string.
    --
    for _ = 1, 128 do
        local prev = safe_u8(startAddr - 1)

        if not printable(prev) then
            break
        end

        startAddr = startAddr - 1
    end

    local chars = {}
    local p = startAddr

    --
    -- Read forward until terminator/non-printable.
    --
    for _ = 1, 256 do
        local b = safe_u8(p)

        if not printable(b) then
            break
        end

        chars[#chars + 1] = string.char(b)
        p = p + 1
    end

    return startAddr, table.concat(chars)
end

local tokens = {
    "PLAYERPOSITION",
    "PLAYER_POS",
    "PLAYERLOCATION",
    "PLAYER_LOCATION",
    "GETPLAYER",
    "SETPLAYER",
    "CONTROLLEDPLAYER",
    "USERCONTROL",
    "BALLCARRIER",

    "POSITION",
    "LOCATION",
    "COORD",
    "TRANSFORM",
    "VELOCITY",
    "MOVEMENT",

    "PLAYER",
    "ENTITY",
    "ACTOR"
}

local seen = {}

log("===== BEGIN =====")

for _, token in ipairs(tokens) do
    local pattern = ascii_pattern(token)

    local ok, hits = pcall(
        cfb.aob_scan,
        pattern,
        128
    )

    if not ok then
        log(string.format(
            "TOKEN %s ERROR %s",
            token,
            tostring(hits)
        ))
    else
        log(string.format(
            "TOKEN %s raw_hits=%d",
            token,
            #hits
        ))

        for _, hit in ipairs(hits) do
            local startAddr, text = containing_string(hit)

            if #text >= 4 then
                local key = string.format(
                    "%X:%s",
                    startAddr,
                    text
                )

                if not seen[key] then
                    seen[key] = true

                    log(string.format(
                        "STRING token=%s addr=0x%X text=%s",
                        token,
                        startAddr,
                        text
                    ))
                end
            end
        end
    end
end

log("===== END =====")