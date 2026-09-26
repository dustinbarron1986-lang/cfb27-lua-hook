local TAG = "[move-api]"

local function log(msg)
    cfb.log(TAG .. " " .. msg)
end

local function is_name_char(b)
    return
        (b >= 65 and b <= 90) or     -- A-Z
        (b >= 48 and b <= 57) or     -- 0-9
        b == 95                      -- _
end

local keywords = {
    "PLAYER",
    "PLYR",
    "POSITION",
    "POS",
    "COORD",
    "LOCATION",
    "LOC",
    "MOVE",
    "MOTION",
    "VELOCITY",
    "VEL",
    "SPEED",
    "BALL",
    "CONTROL",
    "USER",
    "ACTOR",
    "ENTITY",
    "TRANSFORM",
    "WORLD",
    "FIELD",
    "QB",
    "RECEIVER",
    "DEFENDER",
    "OFFENSE",
    "DEFENSE",
    "FORMATION"
}

local function interesting(s)
    for _, keyword in ipairs(keywords) do
        if string.find(s, keyword, 1, true) then
            return true
        end
    end

    return false
end

log("===== BEGIN =====")

local base = cfb.module_base()

-- Known gameplay API names such as GETOFFFORMATION live around
-- CollegeFB27.exe + 0x0B69CF90. Scan a wider neighborhood.
local startAddress = base + 0x0B69C000
local endAddress   = base + 0x0B69F800

log(string.format(
    "scan range 0x%X - 0x%X",
    startAddress,
    endAddress
))

local address = startAddress
local found = 0

while address < endAddress do
    local ok, first = pcall(cfb.read_u8, address)

    if ok and is_name_char(first) then
        local chars = {}
        local p = address

        while p < endAddress do
            local ok2, b = pcall(cfb.read_u8, p)

            if not ok2 or not is_name_char(b) then
                break
            end

            chars[#chars + 1] = string.char(b)

            if #chars >= 96 then
                break
            end

            p = p + 1
        end

        local s = table.concat(chars)

        if #s >= 4 and interesting(s) then
            found = found + 1

            log(string.format(
                "0x%X  %s",
                address,
                s
            ))
        end

        if p > address then
            address = p
        else
            address = address + 1
        end
    else
        address = address + 1
    end
end

log(string.format("candidate names=%d", found))
log("===== END =====")