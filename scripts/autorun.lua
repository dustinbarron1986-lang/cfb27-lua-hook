local ticks = 0
local lastSignature = nil
local lastError = nil

local function read_u32(addr)
    local b0 = cfb.read_u8(addr)
    local b1 = cfb.read_u8(addr + 1)
    local b2 = cfb.read_u8(addr + 2)
    local b3 = cfb.read_u8(addr + 3)

    return b0
        + b1 * 0x100
        + b2 * 0x10000
        + b3 * 0x1000000
end

local function read_u64(addr)
    local lo = read_u32(addr)
    local hi = read_u32(addr + 4)
    return lo + hi * 0x100000000
end

local function read_i32(addr)
    local value = read_u32(addr)
    if value >= 0x80000000 then
        return value - 0x100000000
    end
    return value
end

local SITUATION_ROOT_RVA = 0x0F7261F8
local PLAY_MANAGER_RVA = 0x0E19A908
local PLAY_SIDE_ROOT_RVA = 0x0F7265F0
local PLAY_MAX_STRING_BYTES = 128

local function read_bounded_string(storageAddr, flagAddr)
    local flag = cfb.read_u8(flagAddr)
    local stringAddr = storageAddr

    if (flag & 0x80) ~= 0 then
        stringAddr = read_u64(storageAddr)

        if stringAddr == 0 then
            error("play string pointer unavailable")
        end
    end

    local chars = {}

    for i = 0, PLAY_MAX_STRING_BYTES - 1 do
        local byte = cfb.read_u8(stringAddr + i)

        if byte == 0 then
            return table.concat(chars)
        end

        chars[#chars + 1] = string.char(byte)
    end

    error("play string exceeded maximum length")
end

local function read_play_context(module)
    local manager = read_u64(module + PLAY_MANAGER_RVA)
    if manager == 0 then
        error("manager pointer unavailable")
    end

    local sideRoot = read_u64(module + PLAY_SIDE_ROOT_RVA)
    if sideRoot == 0 then
        error("side root pointer unavailable")
    end

    local context = read_u64(sideRoot + 0x10)
    if context == 0 then
        error("side context pointer unavailable")
    end

    local currentSide = read_u32(context + 0x1C8)
    if currentSide ~= 0 and currentSide ~= 1 then
        error("invalid current side=" .. tostring(currentSide))
    end

    return manager, currentSide
end

local function read_side_call(manager, side)
    if side ~= 0 and side ~= 1 then
        error("invalid call side=" .. tostring(side))
    end

    local pathFlag = cfb.read_u8(manager + 0x1C90 + side)
    if pathFlag ~= 0 then
        return {
            available = false,
            status = "unsupported_path",
            side = side
        }
    end

    local sideObject = manager + 0x10 + side * 0xDE8
    local enclosingObject = sideObject + 0x08
    local playObject = enclosingObject + 0x08

    return {
        available = true,
        status = "ok",
        side = side,
        set = read_bounded_string(enclosingObject + 0x208, enclosingObject + 0x217),
        play = read_bounded_string(playObject + 0x08, playObject + 0x17),
        playId = read_u32(playObject + 0x20)
    }
end

local function read_f32(addr)
    local bits = read_u32(addr)

    local sign = 1
    if bits >= 0x80000000 then
        sign = -1
        bits = bits - 0x80000000
    end

    local exponent = math.floor(bits / 0x800000)
    local mantissa = bits % 0x800000

    if exponent == 255 then
        return 0/0
    elseif exponent == 0 then
        return sign * (mantissa / 0x800000) * (2 ^ -126)
    end

    return sign
        * (1 + mantissa / 0x800000)
        * (2 ^ (exponent - 127))
end

local function is_finite(value)
    return value == value
        and value ~= math.huge
        and value ~= -math.huge
end

local function round(value)
    return math.floor(value + 0.5)
end

local function hash_label(fieldY)
    if fieldY < -1.0 then
        return "left"
    elseif fieldY > 1.0 then
        return "right"
    end

    return "middle"
end

local function possession_label(possession)
    if possession == 0 then
        return "user"
    elseif possession == 1 then
        return "opponent"
    end

    return "unknown"
end

-- Read-only Deer/game API getters are preferred where they have already been
-- exposed into this Lua state. Every call is protected and range-checked; a
-- missing/erroring getter simply falls back to the existing telemetry path.
local function safe_global_number(name, minValue, maxValue)
    local fn = rawget(_G, name)
    if type(fn) ~= "function" then return nil end
    local ok, value = pcall(fn)
    if not ok then return nil end
    local n = tonumber(value)
    if n == nil then return nil end
    if minValue ~= nil and n < minValue then return nil end
    if maxValue ~= nil and n > maxValue then return nil end
    return n
end

local function publish_state()
    local module = cfb.module_base()
    local state = read_u64(module + SITUATION_ROOT_RVA)

    if state == 0 then
        return
    end

    local gameClock  = read_u32(state + 0x164)
    local playClock  = read_u32(state + 0x168)
    local homeScore  = read_u32(state + 0x16C)
    local awayScore  = read_u32(state + 0x170)
    local quarterMemory = cfb.read_u8(state + 0x174)
    local quarterApi = safe_global_number("GETQUARTER", 1, 20)
    local clockApi = safe_global_number("GETTIMEREMAINING", 0, 60 * 60)
    local scoreDiffApi = safe_global_number("GETSCOREDIFF", -200, 200)
    local quarterDisagreement = quarterApi ~= nil and quarterMemory ~= nil and quarterApi ~= quarterMemory
    -- Neither source becomes authoritative merely because its numeric value is valid.
    -- GamePhaseTracker reconciles both sources with lifecycle/clock-wrap evidence.
    local quarter = quarterMemory or quarterApi
    local possession = cfb.read_u8(state + 0x178)
    local down       = read_u32(state + 0x17C)
    local distance   = read_u32(state + 0x180)
    local fieldX     = read_i32(state + 0x184)

    -- Placeholder pending a verified offset: direction (sign) is a guess, not RE-confirmed.
    local lineToGain = fieldX + distance

    local yardLine = round(50 - math.abs(fieldX))
    local possessionLabel = possession_label(possession)

    local offensiveCall = {
        available = false,
        status = "read_error"
    }

    local defensiveCall = {
        available = false,
        status = "read_error"
    }

    local contextOk, manager, currentSide = pcall(function()
        local m, s = read_play_context(module)
        return m, s
    end)

    if contextOk then
        local offensiveSide = currentSide
        local defensiveSide = 1 - currentSide

        local offOk, offResult = pcall(read_side_call, manager, offensiveSide)
        if offOk then
            offensiveCall = offResult
        end

        local defOk, defResult = pcall(read_side_call, manager, defensiveSide)
        if defOk then
            defensiveCall = defResult
        end
    end

    local offensiveSignature = string.format(
        "%s:%s:%s:%s:%s",
        tostring(offensiveCall.available),
        tostring(offensiveCall.side or ""),
        tostring(offensiveCall.set or ""),
        tostring(offensiveCall.play or ""),
        tostring(offensiveCall.playId or "")
    )

    local defensiveSignature = string.format(
        "%s:%s:%s:%s:%s",
        tostring(defensiveCall.available),
        tostring(defensiveCall.side or ""),
        tostring(defensiveCall.set or ""),
        tostring(defensiveCall.play or ""),
        tostring(defensiveCall.playId or "")
    )

    local signature = string.format(
        "%d:%d:%d:%d:%d:%d:%d:%d:%d:%s:%s",
        gameClock,
        playClock,
        homeScore,
        awayScore,
        quarter,
        possession,
        down,
        distance,
        fieldX,
        offensiveSignature,
        defensiveSignature
    )

    if signature == lastSignature then
        return
    end

    lastSignature = signature

    cfb.emit("coord.state", {
        gameClockSeconds = gameClock,
        apiGameClockSeconds = clockApi,
        playClockSeconds = playClock,
        quarter = quarter,
        rawQuarter = quarterMemory,
        apiQuarter = quarterApi,
        quarterTelemetrySource = quarterDisagreement and "DISAGREEMENT" or
            ((quarterApi ~= nil and quarterMemory ~= nil) and "CONSENSUS" or
            (quarterApi ~= nil and "API_CANDIDATE" or "MEMORY_CANDIDATE")),
        quarterDisagreement = quarterDisagreement,

        homeScore = homeScore,
        awayScore = awayScore,
        scoreDifferentialApi = scoreDiffApi,
        scoreDifferentialSource = scoreDiffApi ~= nil and "AUTHORITATIVE_API" or nil,

        possession = possession,
        possessionLabel = possessionLabel,

        down = down,
        distance = distance,

        fieldX = fieldX,
        lineToGain = lineToGain,
        yardLine = yardLine,
        hash = "unknown",

        offensiveCallAvailable = offensiveCall.available,
        offensiveCallStatus = offensiveCall.status,
        offensiveSide = offensiveCall.side,
        offensiveSet = offensiveCall.set,
        offensivePlay = offensiveCall.play,
        offensivePlayId = offensiveCall.playId,

        defensiveCallAvailable = defensiveCall.available,
        defensiveCallStatus = defensiveCall.status,
        defensiveSide = defensiveCall.side,
        defensiveSet = defensiveCall.set,
        defensivePlay = defensiveCall.play,
        defensivePlayId = defensiveCall.playId
    })
end

cfb.log("coordinator autorun loaded")

cfb.on("game_ready", function()
    lastSignature = nil
    lastError = nil
    cfb.log("coordinator game_ready")
end)

cfb.on("tick", function()
    ticks = ticks + 1

    -- Tick is approximately 100 ms. Sample at ~1 Hz.
    if ticks % 10 ~= 0 then
        return
    end

    local ok, err = pcall(publish_state)

    if not ok then
        local message = tostring(err)

        if message ~= lastError then
            lastError = message
            cfb.log("coordinator state read FAILED: " .. message)
        end
    else
        lastError = nil
    end
end)

